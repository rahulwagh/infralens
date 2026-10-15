# Adapter guide

> **Read this first (2026-10-15).** You probably do not need a hand-written adapter
> any more. `adapters/terraform.js` reads any Terraform repo generically and
> classifies module inputs and config files by shape. If a section is empty, start
> by adding your key names to the `pick([...])` lists and `classify()` in that file
> — a one-line change. Write a dedicated adapter only when the repo's structure is
> genuinely unlike Terraform (e.g. a custom JSON schema with no `.tf` at all).

The dashboard never reads your raw JSON. An **adapter** turns the files in your
infra-config repo into the canonical model in `docs/CANONICAL_MODEL.md`, and the UI
renders that. Fitting InfraLens to a new repo means writing or editing one adapter
file. Nothing else changes.

This guide is written so it can be handed, as is, to any LLM you have access to at
work (Copilot, an internal model, anything), or followed by hand. Either way the
result is a single JavaScript file.

---

## Prompt (copy from here when using an LLM)

You are adapting a parser. Produce one JavaScript file, `adapters/<name>.js`, that
sets `window.InfraLensAdapter = { name, extract(files) }`.

**Input.** `files` is an array of `{ path, name, ext, text, json? }`. `path` is
relative to the repo root with forward slashes. `json` is present when the file
parsed as JSON. Terraform `.tf` files arrive as `text` only.

**Output.** `extract` returns a Model object exactly as described in
`docs/CANONICAL_MODEL.md` (paste that file after this prompt). Every entity needs an
`id` (unique across the model) and a `source: { file, path }` saying which file and
which JSON path it came from. Keep ids deterministic: `<project>/<name>` for
networks and firewall rules, the email for service accounts, `<pool id>/<name>` for
providers. References between entities (`network`, `project`, `pool`, `folder`,
`resource`) must use those ids.

**Rules.**
1. Do not compute risk or findings; only extract facts.
2. Strip `projects/`, `folders/`, `organizations/` prefixes from ids, but keep them
   in a folder's `parent` field.
3. Expand IAM policies: one `iam_bindings` row per (resource, role, member).
4. Roles granted *to* a service account go in `iam_bindings` with the SA as
   principal; roles granted *on* a service account (who may use it) go in
   `iam_bindings` with `resource_type: "service_account"` and the SA email as
   resource.
5. Missing optional fields are simply omitted.
6. Wrap per-file work in try/catch and push `{ file, message }` to `model.errors`
   rather than throwing.
7. No external libraries, no network, no `fetch`. Plain browser JavaScript.

**Reference implementation.** `adapters/default.js` does all of the above for the
layout in `sample-infra-config/`. Start from it and change two things: the
`is*File` matchers (which files hold what) and the key names in the `extract*`
functions. Keep `makeEmitter`, `emitBindings` and the helpers.

**My repository.** Below are sanitized samples of my files and the module's
`variables.tf`. Map them.

_(paste 1–2 project files, the org-level files, and variables.tf here)_

---

## Doing it by hand

1. Open `adapters/default.js`.
2. Fix the matchers. If your project files live in `environments/prod/*.json`,
   change `isProjectFile` to match that. Use the "Source files" section of the
   dashboard: anything marked *unused* is a file your matchers are not catching.
3. Fix the keys. If your module calls firewall rules `firewalls` and the CIDR field
   `ip_cidr_range`, change those names in `extractProject`. Several common aliases
   are already handled (`cidr`/`ip_cidr_range`, `rules`/`allow`/`deny`).
4. Check it. Run `node tools/validate.js <your-repo>` if Node exists on the machine;
   otherwise just open `index.html` and look at the counts in the left rail and the
   "Source files" section. Zero dangling references and zero unused files that
   should have been used means you are done.
5. Multiple adapters are fine: copy `default.js` to `adapters/mycompany.js` and change
   the `<script src>` line in `index.html`.

## Common layouts and how to handle them

| Your layout | What to change |
|---|---|
| One JSON per environment containing many projects | Loop over the projects inside `extractProject` and call the emit code per project |
| HCL `.tfvars` instead of JSON | Convert to JSON once (`terraform console` can `jsonencode(var.x)`), or add a minimal HCL reader; JSON is strongly preferred |
| IAM as `{ "group:x": ["roles/a","roles/b"] }` (member → roles) | Invert it in `emitBindings` |
| Firewall rules in a separate `firewall/` folder keyed by network | Add an `isFirewallFile` matcher; derive `project` from the path or a field |
| WIF defined org-wide, not per project | Add an `isWifFile` matcher; set `project` from the file content |
| Org policies inline in each project file | Emit `org_policies` with `scope_type: "project"` from `extractProject` |

## What the UI derives for you (do not emit these)

- `wif_bindings` from any `iam_bindings` on a service account whose principal starts
  with `principalSet://` or `principal://`.
- All relationships (project ↔ folder, subnet ↔ network, binding ↔ resource, …).
- All findings.
