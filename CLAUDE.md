# InfraLens — project context for Claude Code

## What this is
An offline, read-only dashboard giving a bird's-eye view of a GCP estate managed
with Terraform in a "no-code module" setup: the Terraform module lives in one repo,
and a second repo holds JSON configs (projects, networks, firewall rules, IAM,
service accounts, workload identity federation, VPC Service Controls, org policies)
that are passed to the module. InfraLens reads those JSON files (or a gcloud
snapshot) and renders them in a single HTML file.

Owner: Rahul (leads the cloud platform team at a bank). Built in collaboration with
Claude. Claude works outside on sample data; Rahul runs it at work against the real
repo.

## Hard constraints — never break these
- The target machine is a corporate Windows laptop: **no admin rights, no internet,
  no Python/Node guaranteed, no AI tools.** Only a browser (Edge/Chrome), git, and
  Terraform exist for sure. gcloud may be available later.
- Therefore `index.html` must stay a **single static file** with **no external
  resources** (no CDN, no Google Fonts, no npm). System fonts only. No build step.
  The only other runtime files are `adapters/*.js`, loaded via `<script src>`.
- Nothing may be uploaded or sent anywhere. All parsing happens in the browser.
- Never commit real project ids, emails, CIDRs, org numbers or anything from the
  real estate. `sample-infra-config/` is synthetic and must stay that way.
- Node-based `tools/` are for development here only; the dashboard must not depend
  on them.

## Architecture
```
files (JSON/.tf text)  →  adapter (adapters/*.js)  →  canonical model  →  index.html (index, graph, findings, views)
```
- `docs/CANONICAL_MODEL.md` is the contract. Changing it requires updating that doc
  in the same commit and checking every adapter.
- Adapters only **extract facts**. They never compute risk, findings or relationships.
- `index.html` derives relationships (`buildIndex`), WIF bindings from principalSet
  IAM bindings (`normalize`), and findings (`FINDINGS` rules array).
- Adapters register themselves: `window.InfraLensAdapters.push({ name, detect(files), extract(files) })`.
  The first adapter whose `detect` returns true is used.
  - `adapters/default.js` — the repo's no-code JSON layout (declared state). Layout
    assumed is the one in `sample-infra-config/`; Rahul will adapt it to the real repo.
  - `adapters/gcloud.js` — output of `tools/export-gcloud.ps1` / `export_gcloud.py`
    (actual state). Untested against a real estate; parked until gcloud is available.

## Working on it
- Check an adapter: `node tools/validate.js <folder> [adapter.js]` — prints counts,
  unused files, dangling references.
- Build a self-contained preview: `node tools/make_demo.js` → `demo.html` (sample
  data inlined, "Load sample estate" button). `demo.html` is gitignored.
- Visual check: open `demo.html` in a browser, or headless Chromium via Playwright
  (python) as done during development. Views to check: overview, firewall table
  with drawer open, access matrix, workload identity, search.
- Keep the UI dense and plain: tables, chips, one accent colour, red/amber only for
  findings. Light theme by default, dark follows OS. Prose and labels in sentence
  case. No decorative motion.

## Current state (2026-10-14)
- Dashboard, default adapter, canonical model, sample estate, adapter guide,
  validation/demo tools: done and tested on sample data.
- gcloud exporter + adapter: written, not tested (no gcloud available yet).
- Not yet done: see `ROADMAP.md` (CIDR search, shadowed firewall rules, snapshot
  diff / declared-vs-actual, group expansion, HCL reader, per-project page, print CSS).

## Transfer path to the office laptop
Only GitHub is reachable from the office laptop. Push this repo to GitHub, clone it
there. If cloning is not possible, build `demo.html`-style single files that can be
downloaded from the GitHub web UI.

## Conventions
- Commits: short imperative subject, body optional.
- Any new finding rule goes in `FINDINGS` in `index.html` with an `id`, `severity`
  (`high|med|low`), `title`, and a `test(model)` returning
  `{ entity_kind, entity_id, detail }[]`.
- Any new entity type: add to the canonical model doc, `KIND_LABEL`, `SECTIONS`,
  `buildIndex`, both adapters, and `normalize`'s kinds list.
