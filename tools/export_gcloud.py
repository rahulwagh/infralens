#!/usr/bin/env python3
"""
InfraLens gcloud exporter (Python, stdlib only). Same output as export-gcloud.ps1.
Use this when PowerShell scripts are blocked. It runs with any Python 3, including
the one bundled with the Google Cloud SDK:

  for /f "delims=" %p in ('gcloud info --format="value(basic.python_location)"') do "%p" tools\export_gcloud.py

Options:
  --organization ID      numeric org id (auto-detected if omitted)
  --projects a,b,c       only these project ids
  --project-filter EXPR  gcloud --filter for projects list, e.g. labels.env=prod
  --out DIR              output folder (default: snapshot)
  --skip-org             skip folders / VPC-SC / org policies / org IAM
  --skip-sa-policies     skip per-service-account IAM policies (slowest part)
"""
import argparse, datetime, json, os, re, shutil, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument('--organization', default='')
ap.add_argument('--projects', default='')
ap.add_argument('--project-filter', default='')
ap.add_argument('--out', default='snapshot')
ap.add_argument('--skip-org', action='store_true')
ap.add_argument('--skip-sa-policies', action='store_true')
A = ap.parse_args()

GCLOUD = shutil.which('gcloud') or shutil.which('gcloud.cmd')
if not GCLOUD:
    sys.exit('gcloud not found on PATH')
OUT = os.path.abspath(A.out)
os.makedirs(OUT, exist_ok=True)
ERRLOG = os.path.join(OUT, '_errors.log')
open(ERRLOG, 'w').close()

def safe(s): return re.sub(r'[^A-Za-z0-9._@-]', '_', s)

def run(rel, *args):
    """Run a gcloud command, save JSON to OUT/rel, return parsed data or None."""
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = [GCLOUD, *args, '--format=json', '--quiet']
    print('  gcloud ' + ' '.join(args))
    r = subprocess.run(cmd, capture_output=True, text=True, shell=(os.name == 'nt'))
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip()
        with open(ERRLOG, 'a', encoding='utf8') as f:
            f.write(f"[{datetime.datetime.now():%H:%M:%S}] gcloud {' '.join(args)}\n    {msg}\n")
        print('    failed: ' + msg.splitlines()[0] if msg else '    failed')
        return None
    text = r.stdout.strip() or '[]'
    with open(path, 'w', encoding='utf8') as f:
        f.write(text)
    try: return json.loads(text)
    except Exception: return None

print(f'InfraLens gcloud export -> {OUT}')
account = subprocess.run([GCLOUD, 'config', 'get-value', 'account'], capture_output=True, text=True, shell=(os.name == 'nt')).stdout.strip()
print(f'account: {account}')

org, org_domain = A.organization, ''
if not A.skip_org:
    orgs = run('org/organizations.json', 'organizations', 'list') or []
    if not org and orgs:
        org = orgs[0]['name'].replace('organizations/', ''); org_domain = orgs[0].get('displayName', '')
    elif orgs:
        for o in orgs:
            if o['name'] == f'organizations/{org}': org_domain = o.get('displayName', '')
print(f'organization: {org or "(none / not visible)"} {org_domain}')

if not A.skip_org and org:
    print('org-level resources')
    folders, queue = [], [f'organizations/{org}']
    while queue:
        parent = queue.pop(0)
        flag = '--organization=' + parent.split('/')[1] if parent.startswith('organizations/') else '--folder=' + parent.split('/')[1]
        tmp = f'org/_folders_{safe(parent)}.json'
        kids = run(tmp, 'resource-manager', 'folders', 'list', flag) or []
        try: os.remove(os.path.join(OUT, tmp))
        except OSError: pass
        for k in kids:
            folders.append(k); queue.append(k['name'])
    with open(os.path.join(OUT, 'org', 'folders.json'), 'w', encoding='utf8') as f:
        json.dump(folders, f, indent=2)
    print(f'  folders: {len(folders)}')
    run('org/iam_policy.json', 'organizations', 'get-iam-policy', org)
    run('org/org_policies.json', 'org-policies', 'list', f'--organization={org}')
    for fl in folders:
        fid = fl['name'].replace('folders/', '')
        run(f'folders/{fid}/iam_policy.json', 'resource-manager', 'folders', 'get-iam-policy', fid)
        run(f'folders/{fid}/org_policies.json', 'org-policies', 'list', f'--folder={fid}')
    for p in run('org/access_policies.json', 'access-context-manager', 'policies', 'list', f'--organization={org}') or []:
        pid = p['name'].replace('accessPolicies/', '')
        run(f'org/access_levels_{pid}.json', 'access-context-manager', 'levels', 'list', f'--policy={pid}')
        run(f'org/perimeters_{pid}.json', 'access-context-manager', 'perimeters', 'list', f'--policy={pid}')

print('projects')
args = ['projects', 'list'] + ([f'--filter={A.project_filter}'] if A.project_filter else [])
projects = run('org/projects.json', *args) or []
if A.projects:
    want = set(A.projects.split(','))
    projects = [p for p in projects if p['projectId'] in want]
projects = [p for p in projects if p.get('lifecycleState', 'ACTIVE') == 'ACTIVE']
print(f'  {len(projects)} project(s)')

for i, p in enumerate(projects, 1):
    pid = p['projectId']; d = f'projects/{pid}'
    print(f'[{i}/{len(projects)}] {pid}')
    run(f'{d}/project.json', 'projects', 'describe', pid)
    run(f'{d}/iam_policy.json', 'projects', 'get-iam-policy', pid)
    run(f'{d}/org_policies.json', 'org-policies', 'list', f'--project={pid}')
    run(f'{d}/services.json', 'services', 'list', '--enabled', f'--project={pid}')
    run(f'{d}/networks.json', 'compute', 'networks', 'list', f'--project={pid}')
    run(f'{d}/subnets.json', 'compute', 'networks', 'subnets', 'list', f'--project={pid}')
    run(f'{d}/firewall_rules.json', 'compute', 'firewall-rules', 'list', f'--project={pid}')
    run(f'{d}/shared_vpc_host.json', 'compute', 'shared-vpc', 'get-host-project', pid)
    run(f'{d}/shared_vpc_service_projects.json', 'compute', 'shared-vpc', 'associated-projects', 'list', pid)
    sas = run(f'{d}/service_accounts.json', 'iam', 'service-accounts', 'list', f'--project={pid}') or []
    if not A.skip_sa_policies:
        for sa in sas:
            run(f'{d}/sa_iam/{safe(sa["email"])}.json', 'iam', 'service-accounts', 'get-iam-policy', sa['email'], f'--project={pid}')
    for pool in run(f'{d}/wif_pools.json', 'iam', 'workload-identity-pools', 'list', '--location=global', f'--project={pid}') or []:
        name = pool['name'].split('/')[-1]
        run(f'{d}/wif_providers/{safe(name)}.json', 'iam', 'workload-identity-pools', 'providers', 'list', f'--workload-identity-pool={name}', '--location=global', f'--project={pid}')

with open(os.path.join(OUT, '_meta.json'), 'w', encoding='utf8') as f:
    json.dump({'exported_at': datetime.datetime.now().isoformat(), 'account': account, 'organization_id': org, 'organization_domain': org_domain, 'exporter': 'export_gcloud.py'}, f, indent=2)
errs = sum(1 for l in open(ERRLOG, encoding='utf8') if l.startswith('['))
print(f'\ndone. {len(projects)} projects exported to {OUT}. {errs} command(s) failed (see _errors.log).')
print(f"Open index.html and pick the '{A.out}' folder.")
