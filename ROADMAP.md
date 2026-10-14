# Roadmap and split of work

Two people work on this in parallel: **Rahul** at work (real repo, restricted
laptop, no AI tools) and **Claude** outside (this repo, sample data, headless browser
for testing). The contract between the two sides is `docs/CANONICAL_MODEL.md`. As
long as neither side changes it without telling the other, both can move
independently.

## Rahul — at work

1. Clone this repo on the laptop. Open `index.html`, pick the real infra-config
   folder, see what lights up.
2. Go to **Source files** → note which files are *unused*. Those are the files the
   default adapter does not understand yet.
3. Adapt `adapters/default.js` (see `ADAPTER_GUIDE.md`). Commit it as
   `adapters/<company>.js` and switch the `<script src>` in `index.html`.
4. Produce a sanitized sample (fake ids, same shape) of 2–3 real files and
   `variables.tf` of the module, if that is allowed. Even a hand-written description
   of the shape helps. That becomes `sample-infra-config/` v2 and lets Claude test
   against something realistic.
5. Write down which findings are noise for your policy and which checks are missing.
   Those go into `FINDINGS`.

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
- [ ] Minimal HCL/`.tfvars` reader for repos that are not pure JSON.
- [ ] Print/PDF stylesheet for sharing a findings report.
- [ ] Project page: one screen per project collecting its network, rules, IAM, SAs,
      WIF, perimeter, policies.

## Rules of the road

- Never commit real project ids, emails, CIDRs or org numbers to this repo.
- The UI must stay a single file with no external resources. Vendor nothing.
- The adapter extracts; the UI derives. No findings logic in adapters.
- Any change to the canonical model: update `docs/CANONICAL_MODEL.md` in the same
  commit and bump the note at the top.
