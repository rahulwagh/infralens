/*
 * InfraLens adapter — gcloud snapshot (output of tools/export-gcloud.ps1 / export_gcloud.py).
 *
 * Reads gcloud's native --format=json shapes from a snapshot folder:
 *   _meta.json, org/{organizations,folders,projects,iam_policy,org_policies,
 *   access_policies,access_levels_*,perimeters_*}.json, folders/<id>/*.json,
 *   projects/<id>/{project,iam_policy,org_policies,services,networks,subnets,
 *   firewall_rules,shared_vpc_host,shared_vpc_service_projects,service_accounts,
 *   wif_pools}.json, projects/<id>/sa_iam/<email>.json, projects/<id>/wif_providers/<pool>.json
 *
 * This represents ACTUAL state. The default adapter represents DECLARED state (the
 * repo). Both produce the same canonical model.
 */
(function () {
  'use strict';
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const last = (url) => (typeof url === 'string' ? url.split('/').pop() : url);
  // ".../projects/<id>/global/networks/<name>" -> { project, name }
  const parseUrl = (url, kind) => { const m = String(url || '').match(new RegExp('projects/([^/]+)/(?:global|regions/[^/]+)/' + kind + '/([^/]+)')); return m ? { project: m[1], name: m[2] } : null; };
  const principalType = (m) => {
    if (m === 'allUsers') return 'allUsers'; if (m === 'allAuthenticatedUsers') return 'allAuthenticatedUsers';
    if (m.startsWith('principalSet://')) return 'principalSet'; if (m.startsWith('principal://')) return 'principal';
    const i = m.indexOf(':'); return i > 0 ? m.slice(0, i).replace(/^deleted$/, 'deleted') : 'unknown';
  };

  function makeEmitter() {
    const model = { meta: {}, folders: [], projects: [], networks: [], subnets: [], peerings: [], firewall_rules: [], iam_bindings: [], service_accounts: [], wif_pools: [], wif_providers: [], wif_bindings: [], access_levels: [], vpc_sc_perimeters: [], org_policies: [], other: [], errors: [] };
    let seq = 0;
    const emit = (kind, e, file, path) => { if (!e.id) e.id = `${kind}:${++seq}`; e.source = { file, path: path || '' }; model[kind].push(e); return e; };
    return { model, emit };
  }
  function emitBindings(emit, policy, resourceType, resource, file) {
    arr(policy && policy.bindings).forEach((b, i) => arr(b.members).forEach((m) => emit('iam_bindings', {
      id: `${resourceType}:${resource}:${b.role}:${m}`, resource_type: resourceType, resource, principal: m,
      principal_type: principalType(m), role: b.role, condition: b.condition || undefined
    }, file, `bindings[${i}]`)));
  }
  function emitOrgPolicies(emit, list, scopeType, scope, file) {
    arr(list).forEach((p, i) => {
      const constraint = last(p.name || '').replace(/^constraints\//, '');
      const rules = arr(p.spec && p.spec.rules);
      const e = { id: `${scopeType}/${scope}:${constraint}`, constraint, scope_type: scopeType, scope, policy_type: rules.some(r => 'enforce' in r) ? 'boolean' : 'list' };
      for (const r of rules) {
        if ('enforce' in r) e.enforce = !!r.enforce;
        if (r.allowAll) e.allow_all = true; if (r.denyAll) e.deny_all = true;
        if (r.values) { if (r.values.allowedValues) e.allow = [...(e.allow || []), ...r.values.allowedValues]; if (r.values.deniedValues) e.deny = [...(e.deny || []), ...r.values.deniedValues]; }
        if (r.condition) e.condition = r.condition.expression;
      }
      if (p.spec && p.spec.inheritFromParent != null) e.inherit_from_parent = p.spec.inheritFromParent;
      emit('org_policies', e, file, `[${i}]`);
    });
  }

  window.InfraLensAdapters = window.InfraLensAdapters || [];
  window.InfraLensAdapters.push({
    name: 'gcloud-snapshot',
    detect: (files) => files.some(f => f.path === '_meta.json' && f.json && f.json.exporter && String(f.json.exporter).startsWith('export')) || files.some(f => /^projects\/[^/]+\/iam_policy\.json$/.test(f.path)),
    extract(files) {
      const { model, emit } = makeEmitter();
      const byPath = new Map(files.map(f => [f.path, f]));
      const J = (p) => { const f = byPath.get(p); return f && f.json; };
      const numToId = new Map(); // project number -> project id

      const meta = J('_meta.json') || {};
      model.meta.org_id = meta.organization_id; model.meta.org_domain = meta.organization_domain; model.meta.generated_from = `gcloud snapshot ${meta.exported_at || ''} by ${meta.account || ''}`;

      try {
        arr(J('org/folders.json')).forEach((f, i) => emit('folders', { id: last(f.name), name: f.displayName, parent: f.parent || null }, 'org/folders.json', `[${i}]`));
        arr(J('org/projects.json')).forEach((p) => { if (p.projectNumber) numToId.set(String(p.projectNumber), p.projectId); });
        if (J('org/iam_policy.json')) emitBindings(emit, J('org/iam_policy.json'), 'organization', model.meta.org_id || 'org', 'org/iam_policy.json');
        emitOrgPolicies(emit, J('org/org_policies.json'), 'organization', model.meta.org_id || 'org', 'org/org_policies.json');
      } catch (e) { model.errors.push({ file: 'org/*', message: String(e.message || e) }); }

      for (const f of files) {
        try {
          let m;
          if ((m = f.path.match(/^folders\/([^/]+)\/iam_policy\.json$/))) emitBindings(emit, f.json, 'folder', m[1], f.path);
          else if ((m = f.path.match(/^folders\/([^/]+)\/org_policies\.json$/))) emitOrgPolicies(emit, f.json, 'folder', m[1], f.path);
          else if ((m = f.path.match(/^org\/access_levels_[^/]+\.json$/))) arr(f.json).forEach((al, i) => emit('access_levels', { id: last(al.name), name: last(al.name), title: al.title, conditions: al.basic ? al.basic.conditions : al.custom ? [al.custom] : undefined }, f.path, `[${i}]`));
          else if ((m = f.path.match(/^org\/perimeters_[^/]+\.json$/))) arr(f.json).forEach((p, i) => {
            const st = p.status || p.spec || {};
            emit('vpc_sc_perimeters', {
              id: last(p.name), name: last(p.name), title: p.title,
              perimeter_type: /BRIDGE/.test(p.perimeterType || '') ? 'bridge' : 'regular',
              projects: arr(st.resources).map(r => { const n = String(r).replace('projects/', ''); return numToId.get(n) || n; }),
              restricted_services: st.restrictedServices, access_levels: arr(st.accessLevels).map(last),
              ingress_policies: st.ingressPolicies, egress_policies: st.egressPolicies,
              vpc_accessible_services: st.vpcAccessibleServices, dry_run: !!p.spec && !p.status
            }, f.path, `[${i}]`);
          });
        } catch (e) { model.errors.push({ file: f.path, message: String(e.message || e) }); }
      }

      // projects
      const projectDirs = new Set(files.map(f => (f.path.match(/^projects\/([^/]+)\//) || [])[1]).filter(Boolean));
      for (const pid of projectDirs) {
        const d = `projects/${pid}/`;
        try {
          const pj = J(d + 'project.json') || {};
          const host = J(d + 'shared_vpc_host.json');
          const parent = pj.parent || {};
          const services = arr(J(d + 'services.json')).map(s => s.config ? s.config.name : last(s.name));
          emit('projects', {
            id: pid, name: pj.name, number: pj.projectNumber,
            folder: parent.type === 'folder' ? String(parent.id) : undefined,
            labels: pj.labels, apis: services.length ? services : undefined,
            shared_vpc_host: host && host.name && last(host.name) !== pid ? last(host.name) : undefined,
            state: pj.lifecycleState
          }, d + 'project.json', '');
          if (pj.projectNumber) numToId.set(String(pj.projectNumber), pid);

          const svcProjects = arr(J(d + 'shared_vpc_service_projects.json')).map(x => last(x.id || x.name || x));
          arr(J(d + 'networks.json')).forEach((n, i) => {
            const nid = `${pid}/${n.name}`;
            emit('networks', { id: nid, project: pid, name: n.name, routing_mode: n.routingConfig && n.routingConfig.routingMode, shared_vpc_host: svcProjects.length > 0, service_projects: svcProjects.length ? svcProjects : undefined, auto_create_subnets: n.autoCreateSubnetworks, mtu: n.mtu }, d + 'networks.json', `[${i}]`);
            arr(n.peerings).forEach((pr, j) => emit('peerings', { id: `${nid}/${pr.name}`, project: pid, network: nid, name: pr.name, peer_network: pr.network, state: pr.state, export_custom_routes: pr.exportCustomRoutes, import_custom_routes: pr.importCustomRoutes }, d + 'networks.json', `[${i}].peerings[${j}]`));
          });
          arr(J(d + 'subnets.json')).forEach((s, i) => {
            const net = parseUrl(s.network, 'networks'); const nid = net ? `${net.project}/${net.name}` : `${pid}/${last(s.network)}`;
            emit('subnets', { id: `${nid}/${s.name}`, project: pid, network: nid, name: s.name, region: last(s.region), cidr: s.ipCidrRange, private_google_access: !!s.privateIpGoogleAccess, flow_logs: !!(s.logConfig && s.logConfig.enable), purpose: s.purpose, secondary_ranges: arr(s.secondaryIpRanges).map(r => ({ name: r.rangeName, cidr: r.ipCidrRange })) }, d + 'subnets.json', `[${i}]`);
          });
          arr(J(d + 'firewall_rules.json')).forEach((r, i) => {
            const net = parseUrl(r.network, 'networks'); const nid = net ? `${net.project}/${net.name}` : `${pid}/${last(r.network)}`;
            const rules = (r.allowed || r.denied || []).map(x => ({ protocol: x.IPProtocol, ports: x.ports }));
            emit('firewall_rules', { id: `${pid}/${r.name}`, project: pid, network: nid, name: r.name, direction: r.direction || 'INGRESS', action: r.allowed ? 'allow' : 'deny', priority: r.priority == null ? 1000 : Number(r.priority), source_ranges: r.sourceRanges, destination_ranges: r.destinationRanges, source_tags: r.sourceTags, target_tags: r.targetTags, source_service_accounts: r.sourceServiceAccounts, target_service_accounts: r.targetServiceAccounts, rules, disabled: !!r.disabled, logging: !!(r.logConfig && r.logConfig.enable), description: r.description }, d + 'firewall_rules.json', `[${i}]`);
          });
          if (J(d + 'iam_policy.json')) emitBindings(emit, J(d + 'iam_policy.json'), 'project', pid, d + 'iam_policy.json');
          emitOrgPolicies(emit, J(d + 'org_policies.json'), 'project', pid, d + 'org_policies.json');
          arr(J(d + 'service_accounts.json')).forEach((sa, i) => emit('service_accounts', { id: sa.email, project: pid, email: sa.email, account_id: sa.email.split('@')[0], display_name: sa.displayName, description: sa.description, disabled: !!sa.disabled }, d + 'service_accounts.json', `[${i}]`));
          arr(J(d + 'wif_pools.json')).forEach((pool, i) => emit('wif_pools', { id: `${pid}/${last(pool.name)}`, project: pid, name: last(pool.name), display_name: pool.displayName, disabled: !!pool.disabled || pool.state === 'DELETED', full_name: pool.name }, d + 'wif_pools.json', `[${i}]`));
        } catch (e) { model.errors.push({ file: d, message: String(e.message || e) }); }
      }
      // per-SA policies and per-pool providers (file per entity)
      for (const f of files) {
        let m;
        try {
          if ((m = f.path.match(/^projects\/([^/]+)\/sa_iam\/(.+)\.json$/))) {
            const sa = model.service_accounts.find(s => s.project === m[1] && s.email.replace(/[^A-Za-z0-9._@-]/g, '_') === m[2]);
            emitBindings(emit, f.json, 'service_account', sa ? sa.email : m[2], f.path);
          } else if ((m = f.path.match(/^projects\/([^/]+)\/wif_providers\/(.+)\.json$/))) {
            const poolId = `${m[1]}/${m[2]}`;
            arr(f.json).forEach((pr, i) => emit('wif_providers', { id: `${poolId}/${last(pr.name)}`, pool: poolId, project: m[1], name: last(pr.name), type: pr.oidc ? 'oidc' : pr.aws ? 'aws' : pr.saml ? 'saml' : undefined, issuer_uri: pr.oidc ? pr.oidc.issuerUri : pr.aws ? `aws:${pr.aws.accountId}` : undefined, allowed_audiences: pr.oidc && pr.oidc.allowedAudiences, attribute_mapping: pr.attributeMapping, attribute_condition: pr.attributeCondition, disabled: !!pr.disabled || pr.state === 'DELETED' }, f.path, `[${i}]`));
          }
        } catch (e) { model.errors.push({ file: f.path, message: String(e.message || e) }); }
      }
      // Map pool full names onto principalSet bindings so the UI can derive wif_bindings by pool id.
      // (UI matches on ".../workloadIdentityPools/<name>/..." and looks up the pool by name.)
      return model;
    }
  });
})();
