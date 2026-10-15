/*
 * InfraLens adapter — generic Terraform repository (any layout).
 *
 * Reads every .tf / .tfvars / .tf.json / .tfvars.json / .json / .yaml file in the
 * folder, evaluates the Terraform with adapters/hcl.js, and maps what it finds to
 * the canonical model in three passes:
 *
 *   1. google_* resources declared directly (deterministic mapping by type).
 *   2. Values flowing into module calls, locals, variables and standalone tfvars —
 *      classified by *shape* (an object with source_ranges + allow is a firewall
 *      rule wherever it lives, a map of roles/* -> members is IAM, …). This is what
 *      makes no-code module repos work without knowing the module's variable names.
 *   3. JSON / YAML files not consumed by a file() call — same shape classifier.
 *
 * Every resource instance and module call is also listed under `other` so the
 * Terraform objects view shows everything the reader understood, mapped or not.
 */
(function () {
  'use strict';
  const H = (typeof window !== 'undefined' && window.InfraLensHCL) || (typeof require === 'function' ? require('./hcl.js') : null);

  // ---------- helpers ----------
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (v == null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const lastSeg = (s) => String(s).split('/').filter(Boolean).pop();
  const stripRes = (s) => String(s).replace(/^(projects|folders|organizations)\//, '');
  const bool = (v) => (v === true || /^true$/i.test(String(v)) ? true : v === false || /^false$/i.test(String(v)) ? false : undefined);
  const num = (v, d) => (v == null || v === '' ? d : isNaN(Number(v)) ? d : Number(v));
  const principalType = (m) => {
    m = String(m);
    if (m === 'allUsers') return 'allUsers';
    if (m === 'allAuthenticatedUsers') return 'allAuthenticatedUsers';
    if (m.startsWith('principalSet://')) return 'principalSet';
    if (m.startsWith('principal://')) return 'principal';
    const i = m.indexOf(':'); return i > 0 ? m.slice(0, i) : 'unknown';
  };
  const asMember = (m) => { m = String(m); if (/^(user|group|serviceAccount|domain|principal|principalSet|allUsers|allAuthenticatedUsers)/.test(m) || m.includes('://')) return m; if (/\.iam\.gserviceaccount\.com$/.test(m) || /gserviceaccount\.com$/.test(m)) return 'serviceAccount:' + m; if (m.includes('@')) return 'group:' + m; return m; };
  const isMemberLike = (m) => typeof m === 'string' && (/^(user|group|serviceAccount|domain|principal|principalSet):/.test(m) || m === 'allUsers' || m === 'allAuthenticatedUsers' || /\S+@\S+\.\S+/.test(m));
  const isRoleLike = (r) => typeof r === 'string' && (/^roles\//.test(r) || /^(organizations|projects|folders)\/[^/]+\/roles\//.test(r));
  const scopeType = (scope) => { const s = String(scope); if (s.startsWith('organizations/')) return 'organization'; if (s.startsWith('folders/')) return 'folder'; return 'project'; };
  const pick = (o, names) => { for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n]; return undefined; };
  const strList = (v) => (v == null ? undefined : arr(v).map((x) => (isObj(x) ? str(x.cidr || x.range || x.name || x) : str(x))).filter((x) => x !== undefined));
  const netRef = (ref, project) => {
    if (ref == null) return null; const s = String(ref);
    const m = s.match(/projects\/([^/]+)\/(?:global\/)?networks\/([^/]+)/); if (m) return { project: m[1], name: m[2] };
    return { project, name: lastSeg(s) };
  };
  const netId = (ref, project) => { const n = netRef(ref, project); return n ? `${n.project || '?'}/${n.name}` : undefined; };
  const portsOf = (p) => (p == null ? undefined : arr(typeof p === 'string' && p.includes(',') ? p.split(',') : p).map((x) => String(x).trim()).filter(Boolean));
  const rulesOf = (v) => {
    // accepts [{protocol, ports}], {tcp: ["22"]}, "tcp:22,80", ["tcp:22", "udp"]
    if (v == null) return [];
    if (isObj(v) && !('protocol' in v)) return Object.entries(v).map(([k, p]) => ({ protocol: String(k).toLowerCase(), ports: portsOf(p === true || p === null || (Array.isArray(p) && !p.length) ? undefined : p) }));
    return arr(v).map((x) => {
      if (typeof x === 'string') { const [proto, ports] = x.split(':'); return { protocol: proto.toLowerCase(), ports: portsOf(ports) }; }
      if (isObj(x)) return { protocol: String(x.protocol || x.ip_protocol || 'all').toLowerCase(), ports: portsOf(x.ports || x.port) };
      return { protocol: 'all' };
    });
  };

  function makeEmitter() {
    const model = { meta: { generated_from: 'terraform' }, folders: [], projects: [], networks: [], subnets: [], peerings: [], firewall_rules: [], iam_bindings: [], service_accounts: [], wif_pools: [], wif_providers: [], wif_bindings: [], access_levels: [], vpc_sc_perimeters: [], org_policies: [], other: [], errors: [] };
    const seen = new Set(); let seq = 0;
    const emit = (kind, entity, file, path, line) => {
      if (!entity.id) entity.id = `${kind}:${++seq}`;
      const key = kind + '#' + entity.id;
      if (seen.has(key)) return null;
      seen.add(key);
      for (const k of Object.keys(entity)) if (entity[k] === undefined) delete entity[k];
      entity.source = { file, path: path || '', line: line || undefined };
      model[kind].push(entity);
      return entity;
    };
    return { model, emit };
  }

  // ---------- canonical builders shared by resources and shapes ----------
  function emitFirewall(emit, o, ctx, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const name = str(pick(o, ['name', 'rule_name'])) || ctx.mapKey; if (!name) return;
    const allow = o.allow, deny = o.deny;
    const explicitAction = str(pick(o, ['action']));
    const action = explicitAction ? explicitAction.toLowerCase() : (deny != null && (arr(deny).length || isObj(deny)) && !(allow && arr(allow).length)) ? 'deny' : 'allow';
    let rules = rulesOf(pick(o, ['rules', 'allow', 'deny', 'allowed', 'denied']));
    if (!rules.length && (o.protocol || o.ports)) rules = [{ protocol: String(o.protocol || 'all').toLowerCase(), ports: portsOf(o.ports) }];
    if (action === 'deny' && deny != null && !pick(o, ['rules'])) rules = rulesOf(deny);
    const direction = String(pick(o, ['direction']) || 'INGRESS').toUpperCase();
    const network = netId(pick(o, ['network', 'network_name', 'vpc', 'vpc_name']) || ctx.network, project);
    const logging = o.log_config != null ? (arr(o.log_config).length > 0 && arr(o.log_config)[0] !== false) : bool(pick(o, ['logging', 'enable_logging', 'log']));
    emit('firewall_rules', {
      id: `${project}/${name}`, project, network: network || `${project}/?`, name, direction, action,
      priority: num(pick(o, ['priority']), 1000),
      source_ranges: strList(pick(o, ['source_ranges', 'sources', 'source_cidrs', 'src_ranges', 'source_ips', 'src_ip_ranges'])),
      destination_ranges: strList(pick(o, ['destination_ranges', 'destinations', 'dest_ranges', 'destination_cidrs', 'dest_ip_ranges'])),
      source_tags: strList(pick(o, ['source_tags', 'src_tags'])), target_tags: strList(pick(o, ['target_tags', 'targets', 'tags'])),
      source_service_accounts: strList(pick(o, ['source_service_accounts', 'src_service_accounts'])), target_service_accounts: strList(pick(o, ['target_service_accounts'])),
      rules, disabled: bool(pick(o, ['disabled'])) || false, logging: logging || false, description: str(o.description)
    }, src.file, src.path, src.line);
  }
  function emitSubnet(emit, o, ctx, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const name = str(pick(o, ['name', 'subnet_name', 'subnetwork_name'])) || ctx.mapKey; if (!name) return;
    const net = netRef(pick(o, ['network', 'network_name', 'vpc', 'vpc_name', 'subnet_network']) || ctx.network, project);
    const nid = net ? `${net.project || project}/${net.name}` : `${project}/?`;
    const sec = pick(o, ['secondary_ip_range', 'secondary_ranges', 'secondary_ip_ranges']);
    emit('subnets', {
      id: `${nid}/${name}`, project, network: nid, name, region: str(pick(o, ['region', 'subnet_region'])),
      cidr: str(pick(o, ['ip_cidr_range', 'cidr', 'subnet_ip', 'cidr_range', 'range'])) || '?',
      private_google_access: bool(pick(o, ['private_ip_google_access', 'private_google_access', 'subnet_private_access'])),
      flow_logs: o.log_config != null ? arr(o.log_config).length > 0 : bool(pick(o, ['flow_logs', 'subnet_flow_logs', 'enable_flow_logs'])),
      secondary_ranges: sec == null ? undefined : (isObj(sec) && !sec.range_name ? Object.entries(sec).map(([k, v]) => ({ name: k, cidr: str(isObj(v) ? v.ip_cidr_range || v.cidr : v) })) : arr(sec).map((r) => ({ name: str(r.range_name || r.name), cidr: str(r.ip_cidr_range || r.cidr) })))
    }, src.file, src.path, src.line);
  }
  function emitNetwork(emit, o, ctx, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const name = str(pick(o, ['name', 'network_name', 'vpc_name'])) || ctx.mapKey; if (!name) return;
    emit('networks', { id: `${project}/${name}`, project, name, routing_mode: str(pick(o, ['routing_mode'])), shared_vpc_host: bool(pick(o, ['shared_vpc_host', 'is_shared_vpc_host'])), service_projects: strList(pick(o, ['service_projects', 'shared_vpc_service_projects'])) }, src.file, src.path, src.line);
    return { project, name };
  }
  function emitBinding(emit, resourceType, resource, role, member, condition, src) {
    if (role == null || member == null) return;
    member = asMember(member);
    emit('iam_bindings', { id: `${resourceType}:${resource}:${role}:${member}`, resource_type: resourceType, resource: String(resource), principal: member, principal_type: principalType(member), role: String(role), condition: condition ? { title: str(condition.title), expression: str(condition.expression) } : undefined }, src.file, src.path, src.line);
  }
  function emitServiceAccount(emit, o, ctx, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const accountId = str(pick(o, ['account_id', 'name', 'sa_name'])) || ctx.mapKey; if (!accountId) return;
    const email = str(o.email) || (accountId.includes('@') ? accountId : `${accountId}@${project}.iam.gserviceaccount.com`);
    emit('service_accounts', { id: email, project, email, account_id: accountId.includes('@') ? accountId.split('@')[0] : accountId, display_name: str(pick(o, ['display_name'])), description: str(o.description) }, src.file, src.path, src.line);
    // roles granted to the SA, in several popular shapes
    for (const r of arr(pick(o, ['project_roles', 'roles', 'iam_project_roles']))) {
      if (typeof r === 'string') { const m = r.match(/^(?:(.+?)=>)?(roles\/.*)$/); if (m) emitBinding(emit, 'project', m[1] || project, m[2], 'serviceAccount:' + email, null, src); }
      else if (isObj(r) && r.role) emitBinding(emit, r.project || r.folder ? (r.folder ? 'folder' : 'project') : 'project', r.project || r.folder || project, r.role, 'serviceAccount:' + email, r.condition, src);
    }
    for (const r of arr(pick(o, ['org_roles', 'organization_roles']))) emitBinding(emit, 'organization', ctx.org || 'org', r, 'serviceAccount:' + email, null, src);
    return email;
  }
  function emitPool(emit, o, ctx, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const name = str(pick(o, ['workload_identity_pool_id', 'pool_id', 'name'])) || ctx.mapKey; if (!name) return;
    emit('wif_pools', { id: `${project}/${name}`, project, name, display_name: str(o.display_name), disabled: bool(o.disabled) || false }, src.file, src.path, src.line);
    return `${project}/${name}`;
  }
  function emitProvider(emit, o, ctx, poolId, src) {
    const project = str(pick(o, ['project', 'project_id'])) || ctx.project || '?';
    const name = str(pick(o, ['workload_identity_pool_provider_id', 'provider_id', 'name'])) || ctx.mapKey; if (!name) return;
    const pid = poolId || (o.workload_identity_pool_id ? `${project}/${o.workload_identity_pool_id}` : ctx.pool || `${project}/?`);
    const oidc = arr(o.oidc)[0], aws = arr(o.aws)[0], saml = arr(o.saml)[0];
    const type = str(o.type) || (oidc ? 'oidc' : aws ? 'aws' : saml ? 'saml' : o.issuer_uri ? 'oidc' : undefined);
    emit('wif_providers', { id: `${pid}/${name}`, pool: pid, project, name, type, issuer_uri: str(pick(o, ['issuer_uri'])) || (oidc && str(oidc.issuer_uri)) || (aws && 'aws:' + str(aws.account_id)) || undefined, attribute_mapping: isObj(o.attribute_mapping) ? o.attribute_mapping : undefined, attribute_condition: str(o.attribute_condition) }, src.file, src.path, src.line);
  }
  function emitPerimeter(emit, o, ctx, src) {
    const name = lastSeg(str(pick(o, ['name', 'perimeter_name'])) || ctx.mapKey || ''); if (!name) return;
    const st = arr(o.status)[0] || arr(o.spec)[0] || o;
    emit('vpc_sc_perimeters', { id: name, name, title: str(o.title), perimeter_type: str(o.perimeter_type || o.type || 'regular').replace(/^PERIMETER_TYPE_/, '').toLowerCase(), projects: arr(pick(st, ['resources', 'projects'])).map((x) => stripRes(str(x))), restricted_services: strList(st.restricted_services), access_levels: arr(st.access_levels).map((x) => lastSeg(str(x))), ingress_policies: st.ingress_policies || st.ingress_policy, egress_policies: st.egress_policies || st.egress_policy }, src.file, src.path, src.line);
  }
  function emitAccessLevel(emit, o, ctx, src) {
    const name = lastSeg(str(pick(o, ['name'])) || ctx.mapKey || ''); if (!name) return;
    const basic = arr(o.basic)[0];
    emit('access_levels', { id: name, name, title: str(o.title), conditions: basic ? basic.conditions : o.conditions || (o.custom ? [o.custom] : undefined) }, src.file, src.path, src.line);
  }
  function emitOrgPolicy(emit, o, ctx, src, forced) {
    let constraint = str(pick(o, ['constraint', 'constraint_name']));
    let scope = str(pick(o, ['scope', 'parent', 'project', 'project_id', 'folder', 'folder_id', 'org_id', 'organization_id']));
    if (!constraint && o.name && /\/policies\//.test(String(o.name))) { const m = String(o.name).match(/^(.*)\/policies\/(.*)$/); scope = m[1]; constraint = m[2]; }
    if (!constraint) return;
    constraint = constraint.replace(/^constraints\//, '');
    if (scope && /^\d+$/.test(scope) && !ctx.project) scope = 'organizations/' + scope;
    if (!scope) scope = ctx.project ? ctx.project : ctx.org ? 'organizations/' + ctx.org : '?';
    if (forced) scope = forced.startsWith('organizations/') || forced.startsWith('folders/') ? forced : forced;
    const sType = forced ? scopeType(forced) : scopeType(scope);
    const sc = stripRes(scope);
    // google_org_policy_policy shape: spec[0].rules[0]
    const spec = arr(o.spec)[0]; const rule = spec ? arr(spec.rules)[0] : null;
    const bp = arr(o.boolean_policy)[0], lp = arr(o.list_policy)[0];
    let enforce = bool(pick(o, ['enforce', 'enforced'])); let allow = strList(pick(o, ['allow', 'allowed_values', 'allow_values'])); let deny = strList(pick(o, ['deny', 'denied_values', 'deny_values']));
    let deny_all = bool(o.deny_all), allow_all = bool(o.allow_all);
    if (rule) { enforce = bool(rule.enforce) ?? enforce; const vals = arr(rule.values)[0]; if (vals) { allow = strList(vals.allowed_values); deny = strList(vals.denied_values); } if (rule.deny_all != null) deny_all = bool(rule.deny_all); if (rule.allow_all != null) allow_all = bool(rule.allow_all); }
    if (bp) enforce = bool(bp.enforced);
    if (lp) { const a = arr(lp.allow)[0], d = arr(lp.deny)[0]; if (a) { allow = strList(a.values); allow_all = bool(a.all); } if (d) { deny = strList(d.values); deny_all = bool(d.all); } }
    const policy_type = str(o.policy_type) || (enforce != null && !allow && !deny ? 'boolean' : (allow || deny || deny_all || allow_all) ? 'list' : undefined);
    emit('org_policies', { id: `${sc}:${constraint}`, constraint, scope_type: sType, scope: sc, policy_type, enforce, allow, deny, deny_all, allow_all, reason: str(pick(o, ['reason', 'description', 'justification'])) }, src.file, src.path, src.line);
  }
  function emitProject(emit, o, ctx, src) {
    const id = str(pick(o, ['project_id', 'id'])) || ctx.mapKey; if (!id) return;
    const folder = pick(o, ['folder_id', 'folder', 'parent']);
    emit('projects', { id, name: str(o.name), folder: folder == null || /^organizations\//.test(String(folder)) ? undefined : stripRes(str(folder)), labels: isObj(o.labels) ? o.labels : undefined, apis: strList(pick(o, ['apis', 'services', 'activate_apis', 'enabled_apis'])), shared_vpc_host: str(pick(o, ['shared_vpc_host', 'shared_vpc_host_project', 'host_project', 'svpc_host_project_id'])), billing_account: str(pick(o, ['billing_account', 'billing_account_id'])) }, src.file, src.path, src.line);
    return id;
  }
  function emitFolder(emit, o, ctx, src) {
    const name = str(pick(o, ['display_name', 'name'])) || ctx.mapKey; if (!name) return;
    const id = str(pick(o, ['id', 'folder_id'])) || name;
    emit('folders', { id, name, parent: str(pick(o, ['parent'])) || null }, src.file, src.path, src.line);
  }
  // IAM in any shape. resource is {type, id} of what the bindings apply to.
  function emitIamShape(emit, v, resource, src, ctx) {
    if (!v || typeof v !== 'object') return false;
    let hit = false;
    const bind = (role, member, cond) => { emitBinding(emit, resource.type, resource.id, role, member, cond, src); hit = true; };
    if (Array.isArray(v)) {
      for (const b of v) { if (isObj(b) && b.role) { for (const m of arr(b.members || b.member)) bind(b.role, m, arr(b.condition)[0]); } }
      return hit;
    }
    if (v.role && (v.members || v.member)) { for (const m of arr(v.members || v.member)) bind(v.role, m, arr(v.condition)[0]); return hit; }
    if (Array.isArray(v.bindings)) return emitIamShape(emit, v.bindings, resource, src, ctx);
    const keys = Object.keys(v);
    if (keys.length && keys.every(isRoleLike)) { for (const role of keys) for (const m of arr(v[role])) if (typeof m === 'string') bind(role, m); return hit; }
    if (keys.length && keys.every(isMemberLike)) { for (const m of keys) for (const role of arr(v[m])) if (isRoleLike(role)) bind(role, m); return hit; }
    return false;
  }

  // ---------- pass 1: google_* resources ----------
  function mapResource(emit, res, ctx, model) {
    const a = H.plain(res.attrs); const src = { file: res.file, path: res.address, line: res.line };
    const t = res.type; const project = str(pick(a, ['project', 'project_id'])) || ctx.project;
    const c = Object.assign({}, ctx, { project });
    switch (t) {
      case 'google_compute_firewall': emitFirewall(emit, a, c, src); break;
      case 'google_compute_network': { const n = emitNetwork(emit, a, c, src); if (n) ctx.lastNetwork = `${n.project}/${n.name}`; break; }
      case 'google_compute_subnetwork': emitSubnet(emit, a, c, src); break;
      case 'google_compute_network_peering': { const n = netRef(a.network, project); const nid = n ? `${n.project || '?'}/${n.name}` : '?'; emit('peerings', { id: `${nid}/${a.name}`, project: n && n.project || project || '?', network: nid, name: str(a.name), peer_network: str(a.peer_network), export_custom_routes: bool(a.export_custom_routes), import_custom_routes: bool(a.import_custom_routes) }, src.file, src.path, src.line); break; }
      case 'google_project': emitProject(emit, Object.assign({}, a, { folder: a.folder_id || a.folder }), c, src); break;
      case 'google_folder': emitFolder(emit, { display_name: a.display_name, parent: a.parent, id: a.display_name }, c, src); break;
      case 'google_project_service': ctx.apis.push({ project, api: str(a.service) }); break;
      case 'google_compute_shared_vpc_host_project': ctx.hosts.add(str(a.project)); break;
      case 'google_compute_shared_vpc_service_project': ctx.svc.push({ host: str(a.host_project), service: str(a.service_project) }); break;
      case 'google_project_iam_member': case 'google_project_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'project', stripRes(project || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_folder_iam_member': case 'google_folder_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'folder', stripRes(str(a.folder) || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_organization_iam_member': case 'google_organization_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'organization', str(a.org_id) || ctx.org || 'org', a.role, m, arr(a.condition)[0], src); break;
      case 'google_service_account_iam_member': case 'google_service_account_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'service_account', lastSeg(str(a.service_account_id) || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_storage_bucket_iam_member': case 'google_storage_bucket_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'bucket', str(a.bucket) || '?', a.role, m, arr(a.condition)[0], src); break;
      case 'google_secret_manager_secret_iam_member': case 'google_secret_manager_secret_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'secret', lastSeg(str(a.secret_id) || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_bigquery_dataset_iam_member': case 'google_bigquery_dataset_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'dataset', str(a.dataset_id) || '?', a.role, m, arr(a.condition)[0], src); break;
      case 'google_pubsub_topic_iam_member': case 'google_pubsub_topic_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'topic', lastSeg(str(a.topic) || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_kms_crypto_key_iam_member': case 'google_kms_crypto_key_iam_binding': for (const m of arr(a.members || a.member)) emitBinding(emit, 'kms_key', lastSeg(str(a.crypto_key_id) || '?'), a.role, m, arr(a.condition)[0], src); break;
      case 'google_service_account': emitServiceAccount(emit, a, c, src); break;
      case 'google_iam_workload_identity_pool': emitPool(emit, a, c, src); break;
      case 'google_iam_workload_identity_pool_provider': emitProvider(emit, a, c, null, src); break;
      case 'google_access_context_manager_service_perimeter': case 'google_access_context_manager_service_perimeter_resource': emitPerimeter(emit, a, c, src); break;
      case 'google_access_context_manager_access_level': emitAccessLevel(emit, a, c, src); break;
      case 'google_org_policy_policy': emitOrgPolicy(emit, a, c, src); break;
      case 'google_organization_policy': emitOrgPolicy(emit, Object.assign({}, a, { scope: 'organizations/' + str(a.org_id) }), c, src); break;
      case 'google_folder_organization_policy': emitOrgPolicy(emit, Object.assign({}, a, { scope: /^folders\//.test(str(a.folder) || '') ? str(a.folder) : 'folders/' + str(a.folder) }), c, src); break;
      case 'google_project_organization_policy': emitOrgPolicy(emit, Object.assign({}, a, { scope: str(a.project) }), c, src); break;
      default: {
        // generic google_*_iam_member/binding on anything else
        const m = t.match(/^google_(.+)_iam_(member|binding)$/);
        if (m) { const resKey = Object.keys(a).find((k) => /_id$|^name$|^bucket$|^topic$|^instance$/.test(k) && k !== 'role'); for (const mm of arr(a.members || a.member)) emitBinding(emit, m[1], lastSeg(str(resKey ? a[resKey] : '?')), a.role, mm, arr(a.condition)[0], src); break; }
        return false;
      }
    }
    return true;
  }

  // ---------- pass 2/3: shape classification ----------
  const has = (o, ...ks) => ks.some((k) => o[k] !== undefined && o[k] !== null);
  const keyIs = (ctx, re) => re.test(String(ctx.key || ''));
  function classify(o, ctx) {
    if (!isObj(o)) return null;
    if (has(o, 'constraint', 'constraint_name') || (o.name && /\/policies\//.test(String(o.name)))) return 'org_policy';
    if (has(o, 'restricted_services', 'perimeter_type') || (has(o, 'resources') && has(o, 'access_levels', 'status', 'ingress_policies', 'egress_policies')) || (keyIs(ctx, /perimeter/i) && has(o, 'resources', 'projects'))) return 'perimeter';
    if (has(o, 'issuer_uri', 'oidc', 'aws', 'saml', 'attribute_mapping', 'attribute_condition') || has(o, 'workload_identity_pool_provider_id')) return 'wif_provider';
    if (has(o, 'workload_identity_pool_id', 'pool_id') || (keyIs(ctx, /pool/i) && has(o, 'providers'))) return 'wif_pool';
    if (has(o, 'peer_network')) return 'peering';
    const fwSignals = ['source_ranges', 'destination_ranges', 'allow', 'deny', 'direction', 'priority', 'target_tags', 'source_tags', 'target_service_accounts', 'source_service_accounts', 'sources', 'destinations', 'src_ranges', 'dest_ranges', 'source_cidrs'].filter((k) => o[k] !== undefined).length;
    if (fwSignals >= 2 || (fwSignals >= 1 && (keyIs(ctx, /firewall|rules?$|ingress|egress/i) || has(o, 'protocol', 'ports')))) return 'firewall';
    if (has(o, 'ip_cidr_range', 'subnet_ip', 'cidr_range') || (has(o, 'cidr', 'range') && (has(o, 'region', 'subnet_region', 'subnet_name') || keyIs(ctx, /subnet/i)))) return 'subnet';
    if (has(o, 'routing_mode', 'auto_create_subnetworks', 'network_name') || (has(o, 'subnets') && (has(o, 'name', 'vpc_name') || ctx.mapKey)) || (keyIs(ctx, /^(vpc|network)s?$/i) && (has(o, 'name') || ctx.mapKey))) return 'network';
    if (has(o, 'account_id', 'sa_name') || (keyIs(ctx, /service_?accounts?$|^sas?$/i) && (has(o, 'display_name', 'roles', 'project_roles', 'description', 'iam', 'email') || ctx.mapKey))) return 'service_account';
    if (has(o, 'project_id') && (has(o, 'folder', 'folder_id', 'billing_account', 'billing_account_id', 'services', 'apis', 'activate_apis', 'labels', 'parent', 'shared_vpc_host', 'host_project') || keyIs(ctx, /projects?$/i))) return 'project';
    if (keyIs(ctx, /projects?$/i) && ctx.mapKey && has(o, 'folder', 'folder_id', 'billing_account', 'services', 'apis', 'labels', 'iam', 'env')) return 'project';
    if ((has(o, 'display_name', 'name') && has(o, 'parent') && /^(folders|organizations)\//.test(String(o.parent))) || (keyIs(ctx, /folders?$/i) && (has(o, 'parent', 'display_name') || ctx.mapKey))) return 'folder';
    if (has(o, 'conditions', 'basic') && has(o, 'title', 'name')) return 'access_level';
    return null;
  }
  const IAM_KEY = /^(iam|iam_bindings|bindings|iam_members|iam_policy|members|roles|project_iam|folder_iam|org_iam|organization_iam|sa_iam|service_account_iam|iam_binding|iam_additive|iam_authoritative|authoritative|additive|group_iam|user_iam|iam_by_principals|iam_bindings_additive)$/i;

  function scanValue(emit, v, ctx, src, depth) {
    if (depth > 40 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => scanValue(emit, x, Object.assign({}, ctx, { mapKey: undefined, path: src.path + '[' + i + ']' }), Object.assign({}, src, { path: src.path + '[' + i + ']' }), depth + 1)); return; }
    const kind = classify(v, ctx);
    const c = Object.assign({}, ctx);
    const here = str(pick(v, ['project', 'project_id'])); if (here && kind !== 'project' && !/\$\{/.test(here)) c.project = here;
    if (kind === 'firewall') emitFirewall(emit, v, c, src);
    else if (kind === 'subnet') emitSubnet(emit, v, c, src);
    else if (kind === 'network') { const n = emitNetwork(emit, v, c, src); if (n) { c.network = n.name; c.project = n.project; } }
    else if (kind === 'peering') { const project = c.project || '?'; const n = netRef(pick(v, ['network', 'network_name']) || c.network, project); const nid = n ? `${n.project || project}/${n.name}` : `${project}/?`; const name = str(v.name) || ctx.mapKey; if (name) emit('peerings', { id: `${nid}/${name}`, project, network: nid, name, peer_network: str(v.peer_network), export_custom_routes: bool(v.export_custom_routes), import_custom_routes: bool(v.import_custom_routes) }, src.file, src.path, src.line); }
    else if (kind === 'service_account') { const email = emitServiceAccount(emit, v, c, src); if (email) { c.saEmail = email; for (const k of ['iam', 'iam_bindings', 'bindings', 'members', 'users', 'impersonators']) if (v[k] != null) emitIamShape(emit, v[k], { type: 'service_account', id: email }, src, c); } }
    else if (kind === 'project') { const id = emitProject(emit, v, c, src); if (id) c.project = id; }
    else if (kind === 'folder') { emitFolder(emit, v, c, src); const fid = str(pick(v, ['id', 'folder_id'])) || str(pick(v, ['display_name', 'name'])) || ctx.mapKey; c.folder = fid; }
    else if (kind === 'wif_pool') { const pid = emitPool(emit, v, c, src); if (pid) { c.pool = pid; for (const p of arr(v.providers)) if (isObj(p)) emitProvider(emit, p, c, pid, src); if (isObj(v.providers)) for (const [k, p] of Object.entries(v.providers)) if (isObj(p)) emitProvider(emit, p, Object.assign({}, c, { mapKey: k }), pid, src); for (const b of arr(pick(v, ['service_account_bindings', 'sa_bindings', 'bindings']))) if (isObj(b) && (b.service_account || b.sa) && (b.principal_set || b.principal || b.attribute)) { const sa = str(b.service_account || b.sa); const ps = str(b.principal_set || b.principal || b.attribute); emit('wif_bindings', { id: `${pid}:${sa}:${ps}`, pool: pid, service_account: sa, principal_set: ps }, src.file, src.path, src.line); } } }
    else if (kind === 'wif_provider') emitProvider(emit, v, c, c.pool, src);
    else if (kind === 'perimeter') emitPerimeter(emit, v, c, src);
    else if (kind === 'access_level') emitAccessLevel(emit, v, c, src);
    else if (kind === 'org_policy') emitOrgPolicy(emit, v, c, src);
    // IAM-looking members on any object
    for (const [k, child] of Object.entries(v)) {
      if (!IAM_KEY.test(k) || child == null || typeof child !== 'object') continue;
      const target = kind === 'service_account' && c.saEmail ? { type: 'service_account', id: c.saEmail } : /org/i.test(k) ? { type: 'organization', id: c.org || 'org' } : /folder/i.test(k) || (kind === 'folder' && c.folder) ? { type: 'folder', id: c.folder || '?' } : /sa_|service_account/i.test(k) && c.saEmail ? { type: 'service_account', id: c.saEmail } : { type: 'project', id: c.project || '?' };
      emitIamShape(emit, child, target, Object.assign({}, src, { path: src.path + '.' + k }), c);
    }
    // recurse
    for (const [k, child] of Object.entries(v)) {
      if (child == null || typeof child !== 'object') continue;
      const childCtx = Object.assign({}, c, { key: k, mapKey: undefined, parentKind: kind });
      if (isObj(child)) {
        const vals = Object.values(child);
        const mapOfObjects = vals.length > 0 && vals.every(isObj);
        if (mapOfObjects && !classify(child, childCtx)) { for (const [mk, mv] of Object.entries(child)) scanValue(emit, mv, Object.assign({}, childCtx, { mapKey: mk }), Object.assign({}, src, { path: src.path + '.' + k + '[' + JSON.stringify(mk) + ']' }), depth + 2); continue; }
      }
      scanValue(emit, child, childCtx, Object.assign({}, src, { path: src.path + '.' + k }), depth + 1);
    }
  }

  // ---------- entry point ----------
  function extract(files) {
    const { model, emit } = makeEmitter();
    if (!H) { model.errors.push({ file: 'adapters/hcl.js', message: 'HCL reader not loaded' }); return model; }
    // every file goes in: .tf files are evaluated, the rest are there for file()/fileset()
    const repo = H.evaluateRepo(files.map((f) => ({ path: f.path, text: f.text })));
    for (const d of repo.diagnostics) model.errors.push({ file: d.file || '(terraform)', message: (d.line ? 'line ' + d.line + ': ' : '') + d.message });
    const ctxBase = { apis: [], hosts: new Set(), svc: [] };
    const hints = (vars) => { const h = {}; const g = (...ns) => { for (const n of ns) { const v = vars[n]; if (typeof v === 'string' && v && !v.startsWith('${')) return v; } }; h.project = g('project_id', 'project', 'gcp_project', 'gcp_project_id', 'host_project_id'); h.org = g('org_id', 'organization_id', 'gcp_org_id'); h.domain = g('org_domain', 'domain', 'organization_domain'); return h; };
    const walkModule = (mod, ctx) => {
      const vars = H.plain(Object.assign({}, mod.variables, mod.locals));
      const h = hints(vars); const c = Object.assign({}, ctx, { project: h.project || ctx.project, org: h.org || ctx.org });
      if (h.org && !model.meta.org_id) model.meta.org_id = h.org;
      if (h.domain && !model.meta.org_domain) model.meta.org_domain = h.domain;
      for (const r of mod.resources) {
        const mapped = mapResource(emit, r, c, model);
        const a = H.plain(r.attrs);
        emit('other', { id: r.address, kind: 'resource ' + r.type, project: str(pick(a, ['project', 'project_id'])) || c.project, summary: str(pick(a, ['name', 'display_name', 'role', 'constraint', 'service'])) || '', mapped, data: a }, r.file, r.address, r.line);
      }
      for (const m of mod.modules) {
        const inputs = H.plain(m.inputs);
        const mh = hints(inputs); const mc = Object.assign({}, c, { project: mh.project || c.project, org: mh.org || c.org });
        emit('other', { id: m.address, kind: 'module', project: mc.project, summary: m.source, mapped: !!m.local, data: inputs }, m.file, m.address, m.line);
        if (m.local) walkModule(m.local, mc);
        else scanValue(emit, inputs, Object.assign({}, mc, { key: 'module' }), { file: m.file, path: m.address, line: m.line }, 0);
      }
      // values in variables / locals of this module (catches tfvars-driven repos).
      // Skipped when resources or module calls exist: those consume the locals and
      // scanning both would list every rule twice.
      if (mod.resources.length || mod.modules.length) return;
      for (const [k, v] of Object.entries(H.plain(mod.locals))) scanValue(emit, v, Object.assign({}, c, { key: k }), { file: mod.files[0] || mod.dir, path: 'local.' + k }, 0);
      for (const [k, v] of Object.entries(H.plain(mod.variables))) scanValue(emit, v, Object.assign({}, c, { key: k }), { file: mod.tfvars[0] || mod.files[0] || mod.dir, path: 'var.' + k }, 0);
    };
    const rootDirs = [];
    for (const root of repo.roots) { rootDirs.push(root.dir || '.'); walkModule(root, Object.assign({}, ctxBase, { root: root.dir })); }
    model.meta.roots = rootDirs;
    model.meta.read_files = Array.from(new Set((repo.readFiles || []).concat(Array.from(repo.consumedFiles))));
    model.meta.consumed_files = Array.from(repo.consumedFiles);

    // standalone tfvars not attached to any root
    const usedTfvars = new Set(repo.roots.flatMap((r) => r.tfvars));
    for (const f of files) if (/\.tfvars(\.json)?$/i.test(f.path) && !usedTfvars.has(f.path)) {
      const r = H.evaluateTfvars(f.text, f.path); if (r.error) model.errors.push({ file: f.path, message: r.error });
      const vals = H.plain(r.values); const h = hints(vals);
      for (const [k, v] of Object.entries(vals)) scanValue(emit, v, Object.assign({}, ctxBase, { key: k, project: h.project, org: h.org }), { file: f.path, path: k, line: r.lines && r.lines[k] }, 0);
    }
    // JSON / YAML not read through file()
    for (const f of files) {
      if (repo.consumedFiles.has(f.path) || /\.(tf|tfvars)(\.json)?$/i.test(f.path)) continue;
      if (/(^|\/)sync-status\.json$/.test(f.path)) continue; // written by sync.cmd, not estate data
      let data = null;
      if (/\.json$/i.test(f.path)) data = f.json !== undefined ? f.json : (() => { try { return JSON.parse(f.text); } catch (e) { return null; } })();
      else if (/\.ya?ml$/i.test(f.path)) { try { data = H.yamlDecode(f.text); } catch (e) { model.errors.push({ file: f.path, message: 'YAML: ' + e.message }); } }
      if (data == null || typeof data !== 'object') continue;
      const h = isObj(data) ? hints(data) : {};
      const fileHint = (f.path.match(/(?:^|\/)(prj-[a-z0-9-]+|[a-z][a-z0-9-]*-(?:prod|nonprod|dev|test|uat|preprod|sandbox|shared|mgmt|prd|npe|sit))(?:\.json|\.ya?ml|\/)/i) || [])[1];
      scanValue(emit, data, Object.assign({}, ctxBase, { key: f.path.split('/').pop().replace(/\.(json|ya?ml)$/i, ''), project: h.project || fileHint, org: h.org }), { file: f.path, path: '' }, 0);
    }

    // post-pass: shared VPC + apis
    for (const { project, api } of ctxBase.apis) { const p = model.projects.find((x) => x.id === project); if (p) (p.apis = p.apis || []).push(api); }
    for (const { host, service } of ctxBase.svc) { const p = model.projects.find((x) => x.id === service); if (p) p.shared_vpc_host = host; for (const n of model.networks) if (n.project === host) { n.shared_vpc_host = true; (n.service_projects = n.service_projects || []).includes(service) || n.service_projects.push(service); } }
    for (const h of ctxBase.hosts) for (const n of model.networks) if (n.project === h) n.shared_vpc_host = true;
    // firewall rules whose network is unknown: attach to the only network of that project
    for (const r of model.firewall_rules) if (/\/\?$/.test(r.network)) { const nets = model.networks.filter((n) => n.project === r.project); if (nets.length === 1) r.network = nets[0].id; }
    for (const s of model.subnets) if (/\/\?$/.test(s.network)) { const nets = model.networks.filter((n) => n.project === s.project); if (nets.length === 1) s.network = nets[0].id; s.id = `${s.network}/${s.name}`; }
    return model;
  }

  const detect = (files) => files.some((f) => /\.(tf|tfvars)$/i.test(f.path) || /\.(tf|tfvars)\.json$/i.test(f.path));

  if (typeof window !== 'undefined') {
    window.InfraLensAdapters = window.InfraLensAdapters || [];
    window.InfraLensAdapters.push({ name: 'terraform-generic', detect, extract });
  }
  if (typeof module === 'object' && module.exports) module.exports = { name: 'terraform-generic', detect, extract };
})();
