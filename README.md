# InfraLens

An offline, read-only bird's-eye view of a Terraform / GCP estate, built from the
JSON that feeds your no-code Terraform modules. One HTML file, no install, no
server, no internet, no admin rights. Made for locked-down corporate laptops.

Point it at the folder of your infra-config repo and get:

- **Estate overview** — folder/project hierarchy, VPC-SC membership, finding counts
- **Findings** — rule-based checks (public firewall rules, owner/editor grants,
  `allUsers`, SA impersonation, WIF providers without conditions, relaxed org
  policies, …), exportable as CSV
- **Networks / subnets / peerings / firewall rules** — sortable, filterable tables
- **IAM bindings** and an **access matrix** (principal × resource, risky cells in red)
- **Service accounts** — what each holds and who can use it
- **Workload identity federation** — pools, providers, trust conditions, bindings
- **VPC Service Controls** — perimeters, access levels, ingress/egress, projects
  outside every perimeter
- **Org policies** — including where a project relaxes an org-level constraint
- **Global search** — any id, CIDR, email, role, group, or constraint, across everything
- A **detail drawer** for every entity: fields, related entities (click through), and
  the exact source file and JSON path it came from

## Run it

1. Clone this repo onto the laptop (or copy the folder).
2. Have a local checkout of your infra-config repo.
3. Open `index.html` in Edge or Chrome (Firefox works, with a slightly older folder
   picker). Click **Open repo folder**, pick the infra-config checkout.
4. Everything is parsed in the browser. Nothing is uploaded, nothing is written.

`.git`, `.terraform` and `node_modules` are skipped. Only `.json`, `.tf`, `.tfvars`,
`.yaml`, `.yml`, `.hcl`, `.md` are read.

## Fit it to your repo

The default adapter (`adapters/default.js`) expects the layout in
`sample-infra-config/`. Your repo is almost certainly different. Read
`ADAPTER_GUIDE.md` — it takes an hour by hand and a few minutes with any LLM.

## Layout

```
index.html              the whole dashboard (open this)
adapters/default.js     maps your JSON  →  canonical model (edit this)
docs/CANONICAL_MODEL.md the contract between adapter and UI
ADAPTER_GUIDE.md        how to write an adapter (works as an LLM prompt)
sample-infra-config/    synthetic estate used for development and demo
tools/validate.js       node tools/validate.js <repo>  — checks an adapter
tools/make_demo.js      node tools/make_demo.js        — builds demo.html with data inlined
demo.html               generated: dashboard + sample data in one file
ROADMAP.md              what is next and who does what
```

## Adding findings

Rules live in `index.html` under `FINDINGS`. Each is a few lines:

```js
{ id: 'my-rule', severity: 'med', title: 'What is wrong',
  test: (m) => m.firewall_rules.filter(...).map(r => ({ entity_kind: 'firewall_rules', entity_id: r.id, detail: '...' })) }
```

## Design constraints (on purpose)

- Single static file + one adapter file. No build step, no dependencies, no CDN.
- System fonts only (Segoe UI / Consolas on Windows), so it looks right offline.
- Light and dark follow the OS; a toggle is in the header.
- The adapter extracts facts; the UI derives relationships and findings. That keeps
  rules reusable across repos.
