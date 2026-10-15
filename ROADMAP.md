# Roadmap and split of work

Two people work on this in parallel: **Rahul** at work (real repo, restricted
laptop, no AI tools) and **Claude** outside (this repo, sample data, headless browser
for testing). The contract between the two sides is `docs/CANONICAL_MODEL.md`. As
long as neither side changes it without telling the other, both can move
independently.

## Rahul — at work

1. `git pull` this repo on the laptop. Open `index.html`, **Open repo folder**, pick
   the real Terraform repo. The generic reader evaluates it; no adapter work needed
   up front.
2. Look at **Overview → Reader notes** (what could not be resolved), **Terraform
   objects** (everything read; `Mapped` = ✓ means it landed in a section) and
   **Source files** (per-file status). Unmapped objects and *unused* files are the
   gaps.
3. For each gap, send the shape: the key names of one object (fake values are
   fine), the module input name it is passed as, or a sanitized copy of a small
   file plus the module's `variables.tf` if allowed. Claude adds the spellings to
   `adapters/terraform.js` and a matching case to `sample-terraform/`.
4. Put the Bitbucket URLs of all 8–10 repos on the **Repositories** page (or in
   `%USERPROFILE%\infralens-workspace\repos.txt`), run `./sync.sh` from Git Bash
   (`sync.cmd` is blocked by policy). The dashboard opens with the estate loaded.
   Daily: sync, then F5. Report anything in `sync.log` that fails.
5. Write down which findings are noise for your policy and which checks are missing.
   Those go into `FINDINGS`.

## Parked until gcloud is available on the laptop

- `export-gcloud.cmd` / `tools/export-gcloud.ps1` / `tools/export_gcloud.py` and
  `adapters/gcloud.js` are written but untested against a real estate. First run:
  `export-gcloud.cmd -SkipSaPolicies -Projects <one-project>` to check permissions
  and output shapes, then a full run. Report anything in `_errors.log` and any empty
  section in the dashboard.
- Once both sources load, the next feature is declared-vs-actual diff (repo folder
  + snapshot folder side by side).

## Claude — outside

- [ ] Group membership expansion: optional `groups` entity (group → members) so the
      matrix can show effective access per user.
- [ ] Shadowed-rule detection in firewall findings (a higher-priority rule makes a
      lower one dead).
- [ ] CIDR search: typing `10.10.1.5` matches subnets/rules whose range contains it.
- [ ] Diff mode: load two snapshots (two `Export model` files, i.e. two commits) and
      show added/removed/changed entities. This is the "what changed" view for change
      reviews.
- [ ] Optional `terraform show -json` adapter for declared-vs-actual drift, for
      estates where state is reachable from the laptop.
- [x] HCL/`.tfvars` reader with Terraform evaluation (`adapters/hcl.js`), generic
      Terraform adapter (`adapters/terraform.js`), saved copy + re-scan, Terraform
      objects view. 2026-10-15.
- [x] Multi-repo workspace + `sync.cmd`/`sync.sh` + Repositories page. 2026-10-15.
- [ ] Per-repo tag on entities so the same id declared in two repos shows twice
      instead of first-wins.
- [ ] Per-tfvars variants: evaluate a root once per `envs/*.tfvars` so prod and
      nonprod estates both appear (today: auto-loaded tfvars only; other tfvars are
      shape-scanned standalone).
- [ ] Remote module source → fetch the module repo too (second folder picker) so
      module internals are evaluated instead of shape-guessed.
- [ ] Print/PDF stylesheet for sharing a findings report.
- [ ] Project page: one screen per project collecting its network, rules, IAM, SAs,
      WIF, perimeter, policies.

## Rules of the road

- Never commit real project ids, emails, CIDRs or org numbers to this repo.
- The UI must stay a single file with no external resources. Vendor nothing.
  `adapters/*.js` are the only other runtime files.
- The adapter extracts; the UI derives. No findings logic in adapters.
- Any change to the canonical model: update `docs/CANONICAL_MODEL.md` in the same
  commit and bump the note at the top.
