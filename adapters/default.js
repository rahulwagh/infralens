/*
 * InfraLens adapter — default GCP landing-zone / no-code-module layout.
 *
 * CONTRACT
 *   window.InfraLensAdapter = {
 *     name: string,
 *     // files: Array<{ path: string, name: string, ext: string, text: string, json?: any }>
 *     //   `path` is relative to the folder the user picked, forward slashes.
 *     //   `json` is populated for files that parsed as JSON; otherwise undefined.
 *     // returns: Model (see docs/CANONICAL_MODEL.md)
 *     extract(files): Model
 *   }
 *
 * HOW TO ADAPT TO YOUR REPO
 *   1. Change the `isProjectFile` / `isOrgFile` matchers to your folder layout.
 *   2. Change the key names in each `extract*` function to your JSON schema.
 *   3. Leave `emit()` and the helpers alone — they produce the canonical shape.
 *   See ADAPTER_GUIDE.md for a step-by-step (works as an LLM prompt too).
 */
(function () {
  'use strict';

  // ---------- helpers (keep) ----------
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const strip = (s, prefix) => (typeof s === 'string' && s.startsWith(prefix) ? s.slice(prefix.length) : s);
  const stripRes = (s) => strip(strip(strip(String(s), 'projects/'), 'folders/'), 'organizations/');
  const principalType = (m) => {
    if (m === 'allUsers') return 'allUsers';
    if (m === 'allAuthenticatedUsers') return 'allAuthenticatedUsers';
    if (m.startsWith('principalSet://')) return 'principalSet';
    if (m.startsWith('principal://')) return 'principal';
    const i = m.indexOf(':');
    return i > 0 ? m.slice(0, i) : 'unknown';
  };
  const scopeType = (scope) => {
    if (scope.startsWith('organizations/')) return 'organization';
    if (scope.startsWith('folders/')) return 'folder';
    return 'project';
  };

  // Collects entities and auto-assigns ids/source.
  function makeEmitter() {
    const model = {
      meta: {}, folders: [], projects: [], networks: [], subnets: [], peerings: [],
      firewall_rules: [], iam_bindings: [], service_accounts: [], wif_pools: [],
      wif_providers: [], wif_bindings: [], access_levels: [], vpc_sc_perimeters: [],
      org_policies: [], other: [], errors: []
    };
    let seq = 0;
    const emit = (kind, entity, file, path) => {
      if (!entity.id) entity.id = `${kind}:${++seq}`;
      entity.source = { file, path: path || '' };
      model[kind].push(entity);
      return entity;
    };
    return { model, emit };
  }

  // Expand a GCP-style IAM policy { bindings: [{role, members[], condition?}] }
  function emitBindings(emit, policy, resourceType, resource, file, basePath) {
    arr(policy && policy.bindings).forEach((b, i) => {
      arr(b.members).forEach((m) => {
        emit('iam_bindings', {
          id: `${resourceType}:${resource}:${b.role}:${m}`,
          resource_type: resourceType, resource, principal: m,
          principal_type: principalType(m), role: b.role,
          condition: b.condition || undefined
        }, file, `${basePath}.bindings[${i}]`);
      });
    });
  }

  // ---------- file matchers (edit to your layout) ----------
  const isProjectFile = (f) => f.json && /^projects\/[^/]+\.json$/i.test(f.path) && f.json.project;
  const isFoldersFile = (f) => f.json && f.json.folders && /folders\.json$/i.test(f.path);
  const isOrgPolicyFile = (f) => f.json && Array.isArray(f.json.org_policies);
  const isVpcScFile = (f) => f.json && (f.json.perimeters || f.json.access_levels);

  // ---------- extractors (edit key names to your schema) ----------
  function extractProject(emit, f) {
    const j = f.json;
    const p = j.project;
    const pid = p.id;
    emit('projects', {
      id: pid, name: p.name, folder: p.folder ? stripRes(p.folder) : undefined,
      labels: p.labels, apis: p.apis, billing_account: p.billing_account,
      shared_vpc_host: p.shared_vpc_host_project
    }, f.path, 'project');

    arr(j.networks).forEach((n, ni) => {
      const nid = `${pid}/${n.name}`;
      emit('networks', {
        id: nid, project: pid, name: n.name, routing_mode: n.routing_mode,
        shared_vpc_host: !!n.shared_vpc_host, service_projects: n.service_projects
      }, f.path, `networks[${ni}]`);
      arr(n.subnets).forEach((s, si) => emit('subnets', {
        id: `${nid}/${s.name}`, project: pid, network: nid, name: s.name, region: s.region,
        cidr: s.cidr || s.ip_cidr_range, private_google_access: s.private_google_access,
        flow_logs: s.flow_logs, secondary_ranges: s.secondary_ranges
      }, f.path, `networks[${ni}].subnets[${si}]`));
      arr(n.peerings).forEach((pr, pi) => emit('peerings', {
        id: `${nid}/${pr.name}`, project: pid, network: nid, name: pr.name, peer_network: pr.peer_network,
        export_custom_routes: pr.export_custom_routes, import_custom_routes: pr.import_custom_routes
      }, f.path, `networks[${ni}].peerings[${pi}]`));
    });

    arr(j.firewall_rules).forEach((r, ri) => emit('firewall_rules', {
      id: `${pid}/${r.name}`, project: pid, network: `${pid}/${r.network}`, name: r.name,
      direction: (r.direction || 'INGRESS').toUpperCase(), action: (r.action || 'allow').toLowerCase(),
      priority: r.priority == null ? 1000 : Number(r.priority),
      source_ranges: r.source_ranges, destination_ranges: r.destination_ranges,
      source_tags: r.source_tags, target_tags: r.target_tags,
      source_service_accounts: r.source_service_accounts, target_service_accounts: r.target_service_accounts,
      rules: arr(r.rules || r.allow || r.deny).map((x) => ({ protocol: x.protocol, ports: x.ports })),
      disabled: !!r.disabled, logging: !!r.logging, description: r.description
    }, f.path, `firewall_rules[${ri}]`));

    emitBindings(emit, j.iam, 'project', pid, f.path, 'iam');

    arr(j.service_accounts).forEach((sa, si) => {
      const email = sa.email || `${sa.account_id}@${pid}.iam.gserviceaccount.com`;
      emit('service_accounts', {
        id: email, project: pid, email, account_id: sa.account_id,
        display_name: sa.display_name, description: sa.description
      }, f.path, `service_accounts[${si}]`);
      // roles granted TO the SA on the project / org
      arr(sa.project_roles).forEach((role) => emit('iam_bindings', {
        id: `project:${pid}:${role}:serviceAccount:${email}`, resource_type: 'project', resource: pid,
        principal: `serviceAccount:${email}`, principal_type: 'serviceAccount', role
      }, f.path, `service_accounts[${si}].project_roles`));
      arr(sa.org_roles).forEach((role) => emit('iam_bindings', {
        id: `organization:org:${role}:serviceAccount:${email}`, resource_type: 'organization', resource: 'org',
        principal: `serviceAccount:${email}`, principal_type: 'serviceAccount', role
      }, f.path, `service_accounts[${si}].org_roles`));
      // who may use/impersonate the SA
      emitBindings(emit, sa.iam, 'service_account', email, f.path, `service_accounts[${si}].iam`);
    });

    arr(j.workload_identity && j.workload_identity.pools).forEach((pool, pi) => {
      const poolId = `${pid}/${pool.name}`;
      emit('wif_pools', { id: poolId, project: pid, name: pool.name, display_name: pool.display_name, disabled: !!pool.disabled },
        f.path, `workload_identity.pools[${pi}]`);
      arr(pool.providers).forEach((pr, ri) => emit('wif_providers', {
        id: `${poolId}/${pr.name}`, pool: poolId, project: pid, name: pr.name, type: pr.type,
        issuer_uri: pr.issuer_uri, attribute_mapping: pr.attribute_mapping, attribute_condition: pr.attribute_condition
      }, f.path, `workload_identity.pools[${pi}].providers[${ri}]`));
      arr(pool.service_account_bindings).forEach((b, bi) => emit('wif_bindings', {
        id: `${poolId}:${b.service_account}:${b.principal_set}`, pool: poolId,
        service_account: b.service_account, principal_set: b.principal_set
      }, f.path, `workload_identity.pools[${pi}].service_account_bindings[${bi}]`));
    });
  }

  function extractFolders(emit, model, f) {
    const j = f.json;
    if (j.organization) { model.meta.org_id = j.organization.id; model.meta.org_domain = j.organization.domain; }
    arr(j.folders).forEach((fl, i) => emit('folders', {
      id: fl.id, name: fl.display_name || fl.name, parent: fl.parent || null
    }, f.path, `folders[${i}]`));
  }

  function extractOrgPolicies(emit, f) {
    arr(f.json.org_policies).forEach((p, i) => emit('org_policies', {
      id: `${p.scope}:${p.constraint}`, constraint: p.constraint, scope_type: scopeType(p.scope),
      scope: stripRes(p.scope), policy_type: p.policy_type, enforce: p.enforce, allow: p.allow, deny: p.deny,
      deny_all: p.deny_all, allow_all: p.allow_all, reason: p.reason
    }, f.path, `org_policies[${i}]`));
  }

  function extractVpcSc(emit, f) {
    const j = f.json;
    arr(j.access_levels).forEach((al, i) => emit('access_levels', {
      id: al.name, name: al.name, title: al.title, conditions: al.conditions
    }, f.path, `access_levels[${i}]`));
    arr(j.perimeters).forEach((p, i) => emit('vpc_sc_perimeters', {
      id: p.name, name: p.name, title: p.title, perimeter_type: p.perimeter_type,
      projects: arr(p.resources).map(stripRes), restricted_services: p.restricted_services,
      access_levels: p.access_levels, ingress_policies: p.ingress_policies, egress_policies: p.egress_policies
    }, f.path, `perimeters[${i}]`));
  }

  // ---------- entry point ----------
  window.InfraLensAdapters = window.InfraLensAdapters || [];
  window.InfraLensAdapters.push({
    name: 'default-gcp-landing-zone',
    // Claims a folder when at least one file looks like a no-code project config.
    detect: (files) => files.some(isProjectFile) || files.some(isFoldersFile),
    extract(files) {
      const { model, emit } = makeEmitter();
      for (const f of files) {
        try {
          if (isProjectFile(f)) extractProject(emit, f);
          else if (isFoldersFile(f)) extractFolders(emit, model, f);
          else if (isOrgPolicyFile(f)) extractOrgPolicies(emit, f);
          else if (isVpcScFile(f)) extractVpcSc(emit, f);
          // unmatched files are simply ignored; the UI lists them under "Files"
        } catch (e) {
          model.errors.push({ file: f.path, message: String(e && e.message || e) });
        }
      }
      return model;
    }
  });
})();
