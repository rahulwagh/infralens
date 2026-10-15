# InfraLens — handoff summary (chat of 2026-10-14)

## The problem
Rahul leads the cloud platform team at a bank. At work: Terraform + GCP, "no-code
module" pattern — the Terraform module lives in one Bitbucket repo, a second repo
holds JSON configs that are passed to the module to provision everything (network,
firewall, landing zone, IAM, service accounts, workload identity federation, VPC
Service Controls, org policies). He wants a dashboard that gives a deep bird's-eye
view of all of it from one place: firewall rules, groups, user permissions, SAs,
WIF, etc.

Constraints at work: no internet, no AI tools, no Claude, Windows laptop, corporate
restrictions, **no admin rights**. Only a browser, git, Terraform are certain.
gcloud auth is sometimes available (not right now). GitHub is reachable from the
office laptop; copying files from the personal Mac is not.

## Decisions made
1. **Don't use a local LLM to build the dashboard.** It can't be installed without
   admin, weights can't be transferred, CPU-only would crawl, and a small model
   would hallucinate security facts. Parsing JSON is deterministic work.
2. **LLM's role is the adapter-writer**, not the engine: `ADAPTER_GUIDE.md` is
   written as a prompt any LLM (or a human) can follow to map Rahul's JSON schema to
   the canonical model.
3. **Browser-only architecture.** One `index.html`, no CDN, no fonts, no build, no
   server. Folder picker (File System Access API, `webkitdirectory` fallback) reads
   the repo locally. Nothing leaves the machine. Works without admin.
4. **Three layers**: adapters (repo-specific, pluggable) → canonical model (the
   contract, `docs/CANONICAL_MODEL.md`) → UI (generic: index, relationship graph,
   findings engine, views). Adapters extract facts only; the UI derives relations
   and findings.
5. **Two data sources, same UI**: the repo JSON (declared state, `adapters/default.js`)
   and a gcloud snapshot (actual state, `adapters/gcloud.js` + `export-gcloud.cmd`).
   The dashboard auto-detects which folder type was opened. The gcloud path is
   parked until gcloud is available on the laptop; declared-vs-actual diff is the
   next feature once both load.
6. **Design**: system fonts (Segoe UI / Consolas), light default + dark via OS,
   one accent colour, red/amber reserved for findings, dense tables, a right-hand
   drawer per entity showing fields, related entities (click-through) and the exact
   source file + JSON path.

## What was built and tested
- `index.html` — overview (hierarchy tree with VPC-SC membership and finding
  counts), findings (18 rules, CSV export), projects, folders, networks, subnets,
  peerings, firewall rules, IAM bindings, access matrix (principal × resource,
  risky cells red), service accounts, workload identity, VPC-SC, org policies,
  source files (shows which files the adapter did not use), global search, model
  export. Rendered in headless Chromium, zero console errors.
- `adapters/default.js` — for the layout in `sample-infra-config/`.
- `adapters/gcloud.js` — for gcloud `--format=json` shapes; untested on real data.
- `sample-infra-config/` — synthetic bank estate (5 projects, 3 VPCs, 12 firewall
  rules, 59 bindings, 11 SAs, 2 WIF pools, 2 perimeters, 8 org policies) with
  deliberate problems so every view and finding is exercised.
- `tools/validate.js` (Node) — adapter check: counts, unused files, dangling refs.
- `tools/make_demo.js` (Node) — builds `demo.html` with data inlined (gitignored).
- `tools/export-gcloud.ps1`, `tools/export_gcloud.py`, `export-gcloud.cmd` —
  read-only gcloud exporter to a `snapshot/` folder; continue-on-error; Python twin
  runs on the Cloud SDK's bundled Python if PowerShell scripts are blocked.
- `CLAUDE.md` (project context), `README.md`, `ADAPTER_GUIDE.md`, `ROADMAP.md`,
  `docs/CANONICAL_MODEL.md`.

## State of the repo
- Local git repo with 3 commits; branch `master`.
- GitHub repo created by Rahul: https://github.com/rahulwagh/infralens (empty).
  Push from the Claude session was refused (Claude GitHub App not installed on
  that repo). Either install the app / reconnect GitHub in claude.ai, or push from
  the Mac: `git remote add origin https://github.com/rahulwagh/infralens.git && git push -u origin master`.
- Transfer to the office laptop = clone from GitHub.

## Next steps
Rahul (at work): clone, open `index.html`, open the real infra-config folder, check
"Source files" for *unused* files, adapt `adapters/default.js`, commit as
`adapters/<company>.js`. Provide a sanitized sample of 2–3 real JSON files and the
module's `variables.tf` if allowed. When gcloud is available: run
`export-gcloud.cmd -SkipSaPolicies -Projects <one>` first, then a full export.

Claude (outside): CIDR search, shadowed firewall rule detection, snapshot diff
(declared vs actual / commit vs commit), group membership expansion, minimal HCL
reader, per-project page, print CSS. Full list in `ROADMAP.md`.


---

# Session 2 — 2026-10-15

## What happened
- Repo pushed to GitHub from the Mac (`git@github.com:rahulwagh/infralens.git`,
  branch `master`); the office laptop clones it through a local Cntlm proxy
  (`git config --global http.proxy http://localhost:3128`).
- Rahul opened `index.html` against the real repo: nothing rendered. The real repo
  is a full Terraform repository (many folders, `.tf`, tfvars, JSON scattered
  inside), not the hand-made JSON layout the default adapter expected.
- Rahul's ask: a generic parser that reads Terraform, all its variables and the
  JSON, builds the dashboard, keeps it after a refresh, and re-syncs after a pull.

## Built
- `adapters/hcl.js` — HCL2 reader + Terraform evaluator (see CLAUDE.md).
- `adapters/terraform.js` — generic mapper: resources by type, module inputs /
  tfvars / JSON / YAML by shape, everything listed under Terraform objects.
- `index.html` — loads the new adapters (terraform last, as fallback), keeps the
  opened files + directory handle in IndexedDB, restores on startup, **Re-scan**
  button, **Terraform objects** view, Source files statuses + Clear saved copy,
  drawer shows HCL source from the recorded line, Reader notes on the overview.
- `sample-terraform/` — synthetic repo covering the patterns; `tools/validate.js`
  and `tools/make_demo.js` now load all adapters like the browser.
- Verified with Playwright over `file://`: 16 checks, zero console errors.

## Next
Rahul: `git pull`, open the real repo, report Reader notes, unmapped Terraform
objects and unused files (shapes / key names, fake values). Claude: extend key
lists, per-tfvars variants, remote-module folder, then the earlier roadmap items.

## Later the same day — multi-repo sync
- Rahul has 8–10 Bitbucket repos. Opening a parent folder already scans them all;
  added `sync.cmd` / `sync.sh` (clone or pull every repo in `<workspace>/repos.txt`,
  write `sync-status.json`, open the dashboard) and a **Repositories** page (edit +
  save the list, see last sync per repo). Tested on macOS with local bare repos and
  Playwright; `sync.cmd` itself still needs its first Windows run.
