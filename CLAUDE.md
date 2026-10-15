# InfraLens — project context for Claude Code

## What this is
An offline, read-only dashboard giving a bird's-eye view of a GCP estate managed
with Terraform. Rahul's repo is a "no-code module" setup: the Terraform module lives
in one Bitbucket repo, a second repo holds `.tf` files, tfvars and JSON configs
(projects, networks, firewall rules, IAM, service accounts, workload identity
federation, VPC Service Controls, org policies) passed to that module. InfraLens
evaluates the Terraform in the browser (or reads a gcloud snapshot) and renders it
in a single HTML file.

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
files (.tf/.tfvars/JSON/YAML text)  →  adapter (adapters/*.js)  →  canonical model  →  index.html (index, graph, findings, views)
```
- `docs/CANONICAL_MODEL.md` is the contract. Changing it requires updating that doc
  in the same commit and checking every adapter.
- Adapters only **extract facts**. They never compute risk, findings or relationships.
- `index.html` derives relationships (`buildIndex`), WIF bindings from principalSet
  IAM bindings (`normalize`), and findings (`FINDINGS` rules array).
- Adapters register themselves: `window.InfraLensAdapters.push({ name, detect(files), extract(files) })`.
  The first adapter whose `detect` returns true is used; load order in `index.html`
  is default → gcloud → terraform, so the specific ones win over the generic one.
  - `adapters/hcl.js` — HCL2 lexer/parser + Terraform expression evaluator (no deps).
    `evaluateRepo(files)` finds root modules (dirs with .tf not referenced as a local
    module), loads `terraform.tfvars` / `*.auto.tfvars`, evaluates variables, locals,
    resources (for_each/count/dynamic expanded), module calls (local sources are
    evaluated recursively, outputs exposed), and reports `diagnostics`,
    `readFiles`, `consumedFiles` (read via `file()`/`fileset()`). Unknown values are
    `Unknown` objects rendered as `${expr}`. Works in Node too (`module.exports`).
  - `adapters/terraform.js` — generic mapper: (1) `google_*` resources by type,
    (2) module inputs / standalone tfvars / locals-without-consumers classified by
    shape (`classify()` + the `pick()` key lists in each `emit*`), (3) JSON/YAML not
    consumed by `file()`. Every resource instance and module call also goes to
    `other` (the "Terraform objects" view) with `mapped: true|false`. Dedup is by
    kind+id, first emitter wins (resources before shapes).
  - `adapters/default.js` — the hand-made JSON layout in `sample-infra-config/`.
  - `adapters/gcloud.js` — output of `tools/export-gcloud.ps1` / `export_gcloud.py`
    (actual state). Untested against a real estate; parked until gcloud is available.
- Multi-repo sync, single-folder layout (Rahul asked for this explicitly on
  2026-10-15 — keep it simple, no workspace argument): `repos.txt` next to
  `sync.cmd` lists URLs; `sync.cmd`/`sync.sh` clone or pull into `repos/<name>/`,
  write `sync-status.json`, `sync.log` and `estate.js`, all gitignored.
  `estate.js` = `window.__INFRALENS_ESTATE__ = {name, generated_at, workspace,
  files:[{path,text}]}` with paths relative to `repos/` plus `repos.txt` and
  `sync-status.json` at the root; built by one awk program in `sync.sh`
  (`--build-only`), `sync.cmd` calls Git's `bash.exe` for it and falls back to an
  inline PowerShell command. `index.html` includes `estate.js` (404 harmless) and
  `boot()` loads it unless the IndexedDB saved copy is newer; header button is
  **Reload** in that mode. Rahul serves index.html from IntelliJ's built-in server
  (localhost:63342) — relative `estate.js` works there too. The **Repositories**
  section (`renderRepos`) shows list + status and can write `repos.txt` via the File
  System Access API (asks for the InfraLens folder), download fallback.
  Rahul moved to SSH URLs (`ssh://git@host:7999/proj/repo.git`); `@` is only
  treated as credentials when the URL starts with http(s). Earlier he used
  `https://USER:TOKEN@host/scm/...` URLs with a read-only token: both
  scripts compute SAFE (credentials stripped) for names, log, status and echo, pass
  the raw URL only to git, and scrub git's output before appending to sync.log
  (`call set` trick in batch, `index()` loop in awk). `redactUrl()` in index.html
  covers display of repos.txt URLs. Tested with a token URL against a refused port.
  Per-script git options come from optional gitignored `sync.local.cmd` /
  `sync.local.sh` (`GITOPTS`, e.g. `-c http.sslVerify=false` for the corporate
  TLS-inspecting proxy — Rahul asked for this; kept off `--global` on purpose).
  `repos.txt` / `sync-status.json` are `INFRALENS_FILES`, never estate data; the
  terraform adapter skips `sync-status.json`. Files carry `mtime` when read from a
  folder.
- Persistence: `index.html` keeps the last opened files (and the directory handle in
  Chrome/Edge) in IndexedDB (`infralens` / `kv`), restores on startup, and the
  **Re-scan** button re-reads the same folder. Last section is in localStorage.
  Demo pages (`__INFRALENS_DEMO__`) skip the restore.

## Working on it
- Check the adapters: `node tools/validate.js <folder> [adapter.js]` — loads all
  adapters like the browser (or just the named one), prints counts, unused files,
  dangling references; `--dump` writes `model.json`.
- `node tools/validate.js sample-terraform` must give 0 errors and only README.md
  unused. `node tools/validate.js sample-infra-config` must still pick
  `default-gcp-landing-zone`.
- Build a self-contained preview: `node tools/make_demo.js sample-terraform` →
  `demo.html` (all adapters + data inlined, "Load sample estate" button). Gitignored.
- Browser check over `file://` (IndexedDB, picker fallback via `#dirInput`): a
  Playwright (python) venv in the session scratchpad ran 16 checks with zero console
  errors on 2026-10-15 — load, every view, HCL snippet in the drawer, reload restores
  the saved copy and last section, clear, demo, default sample auto-detect. The
  desktop browser pane turns local files into `data:` URLs and corrupts inlined JS,
  so use Playwright or the `static` entry in `.claude/launch.json` (python
  http.server on 8765) instead.
- `tools/make_demo.js` must use a function replacement in `String.replace`; the
  adapter code contains `$&`.
- `sync.cmd` cannot run here; `sync.sh` was tested against local bare repos
  (clone, pull of a new commit, one bad URL) and its `sync-status.json` through the
  Repositories page with Playwright. Keep the two scripts' behaviour and JSON
  identical when changing either. Batch pitfalls in `sync.cmd`: delayed expansion
  (`!` in commit subjects is mangled, acceptable), JSON built in a variable, special
  characters stripped from subjects.
- Keep the UI dense and plain: tables, chips, one accent colour, red/amber only for
  findings. Light theme by default, dark follows OS. Prose and labels in sentence
  case. No decorative motion.

## Current state (2026-10-15, evening)
- Simplified to the single-folder layout above after Rahul found the workspace /
  Open folder / Re-scan flow too complicated. Tested here: sync.sh clone + pull
  against local bare repos into `repos/`, byte-exact estate.js, autoload over
  file:// and over http://localhost (IntelliJ-like) with Playwright. `sync.cmd`
  still untested on Windows (its PowerShell fallback especially).

## Earlier state (2026-10-15, later)
- Added multi-repo sync: `sync.cmd`/`sync.sh`, Repositories page, sync status on
  the overview, and `estate.js` auto-load so sync → open page needs no clicks.
  `sync.cmd` is blocked by policy on Rahul's laptop; `sync.sh` from Git Bash works
  there (he made local edits to sync.cmd, so expect a stash/conflict on pull).
  Round trip of estate.js verified byte-exact on 24 files; autoload, Reload,
  precedence vs saved copy and the no-estate fallback verified with Playwright.
- Generic Terraform reader (`hcl.js` + `terraform.js`), saved copy + re-scan,
  Terraform objects view, line-based source snippets: done, tested on
  `sample-terraform/` (synthetic: direct resources, for_each over
  `jsondecode(file())`, `fileset`, dynamic blocks, local module, remote module fed
  from JSON, standalone tfvars, YAML). Not yet run against Rahul's real repo — that
  is the next step; expect to extend the key lists in `classify()` / `pick()`.
- Default JSON adapter, gcloud exporter + adapter: unchanged. gcloud path untested.
- Not yet done: see `ROADMAP.md`.

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
  `buildIndex`, every adapter, and `normalize`'s kinds list.
- New key spellings for the shape classifier go in `adapters/terraform.js`: the
  `pick([...])` lists inside `emitFirewall` / `emitSubnet` / … and the signals in
  `classify()`. Add a case to `sample-terraform/` that exercises it.
