# InfraLens

An offline, read-only bird's-eye view of a Terraform / GCP estate, read straight
from the Terraform repository — `.tf`, `.tfvars`, JSON and YAML in any layout. One
HTML file, no install, no server, no internet, no admin rights. Made for
locked-down corporate laptops.

Point it at the folder of your Terraform repo and get:

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
2. Have a local checkout of your Terraform repo.
3. Open `index.html` in Edge or Chrome (Firefox works, with a slightly older folder
   picker). Click **Open repo folder**, pick the Terraform checkout.
4. Everything is parsed in the browser. Nothing is uploaded, nothing is written.
5. The files you opened are kept in the browser's IndexedDB, so a refresh or a new
   browser session shows the same dashboard. After `git pull`, click **Re-scan**
   (Edge/Chrome re-read the folder without asking again; Firefox shows the picker).
   **Source files → Clear saved copy** removes the stored copy.

`.git`, `.terraform` and `node_modules` are skipped. Only `.json`, `.tf`, `.tfvars`,
`.yaml`, `.yml`, `.hcl`, `.md` are read.

## How a Terraform repo is read

`adapters/hcl.js` is a small HCL2 reader and Terraform expression evaluator: it
resolves variables (defaults, `terraform.tfvars`, `*.auto.tfvars`), locals,
`for_each` / `count`, dynamic blocks, string templates, conditionals, for
expressions, splats, local modules and their outputs, and the usual built-in
functions — including `jsondecode(file(...))`, `yamldecode(file(...))` and
`fileset(...)`, which no-code repos lean on. Anything it cannot know (data sources,
remote module outputs, computed attributes) is shown as `${...}` rather than
guessed.

`adapters/terraform.js` then maps three things into the dashboard:

1. **`google_*` resources** declared directly — firewall, networks, subnets, peerings,
   projects, folders, IAM members/bindings on any resource, service accounts,
   workload identity pools/providers, VPC-SC access levels/perimeters, org policies,
   shared-VPC host/service links, enabled APIs.
2. **Values passed to modules** (and standalone tfvars) — classified by *shape*: an
   object with `source_ranges` and `allow` is a firewall rule wherever it sits, a
   map of `roles/*` to members is IAM, an object with `ip_cidr_range` is a subnet,
   and so on. This is what makes a repo that only calls a module in another
   repository work without knowing the module's variable names.
3. **JSON / YAML files** not read by any `file()` call — same shape classifier.

Everything the reader understood is listed under **Terraform objects** (every
resource instance and module call, with the evaluated attributes), and **Source
files** shows per file whether it produced entities, was read via `file()`, was
evaluated, or was not understood at all. Those two views are where to look when a
section is empty.

## Three data sources, same dashboard

| Source | Adapter | How |
|---|---|---|
| Any Terraform repo (**declared** state) | `adapters/terraform.js` + `adapters/hcl.js` | Open the repo folder |
| A no-code JSON config repo in the `sample-infra-config/` layout | `adapters/default.js` | Open the repo folder |
| The live estate via gcloud (**actual** state) | `adapters/gcloud.js` | Run `export-gcloud.cmd` (read-only, needs an authenticated gcloud), then open the `snapshot` folder it writes |

The dashboard detects which kind of folder you opened and picks the adapter. If
PowerShell scripts are blocked, the gcloud wrapper tells you how to run the same
exporter through the Python that ships inside the Cloud SDK.

## When something is not mapped

The shape classifier covers the common naming conventions. If your repo uses a
different one (say `cidr_block` instead of `ip_cidr_range`), the entities appear
under **Terraform objects** but not in their own section. Two ways to fix that:

- add the key name to the matching `pick(...)` / `classify(...)` list in
  `adapters/terraform.js`, or
- write a repo-specific adapter as described in `ADAPTER_GUIDE.md` (works as an
  LLM prompt).

## Layout

```
index.html              the whole dashboard (open this)
adapters/hcl.js         HCL2 reader + Terraform expression evaluator
adapters/terraform.js   generic Terraform repo  →  canonical model
adapters/default.js     the sample-infra-config JSON layout  →  canonical model
adapters/gcloud.js      gcloud snapshot  →  canonical model
docs/CANONICAL_MODEL.md the contract between adapter and UI
ADAPTER_GUIDE.md        how to write a repo-specific adapter (works as an LLM prompt)
sample-terraform/       synthetic Terraform repo used for development and demo
sample-infra-config/    synthetic no-code JSON estate (older layout)
tools/validate.js       node tools/validate.js <repo>   — runs the adapters like the browser does
tools/make_demo.js      node tools/make_demo.js <repo>  — builds demo.html with data inlined
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

- Single static file + the adapter files. No build step, no dependencies, no CDN.
- System fonts only (Segoe UI / Consolas on Windows), so it looks right offline.
- Light and dark follow the OS; a toggle is in the header.
- The adapter extracts facts; the UI derives relationships and findings. That keeps
  rules reusable across repos.
