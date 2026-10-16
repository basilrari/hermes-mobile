# Carried upstream patches

Patches in this directory are **temporary carries** for upstream fixes the mobile
build needs before they land in `NousResearch/hermes-agent`. They are unrelated to
`patches/*.patch` at the repo root, which are `patch-package` files applied by
`npm ci`; `patch-package` only globs the top level, so this subdirectory is ignored
by it.

## Rules

1. **One patch, one upstream PR.** The filename names the PR and the subject, e.g.
   `115161-relay-empty-roster.patch`. The first line of the patch body (the commit
   subject) must match, and the PR must be linked in the table below.
2. **Add the link.** Every patch gets a row here. A patch with no row fails review.
3. **Reproduce it from a commit.** Generate with `git format-patch`/`git diff` in a
   checkout of `NousResearch/hermes-agent` at the pinned SHA, targeting the same
   paths this repo vendors (`apps/desktop/**`, `apps/shared/**`).
4. **Removal condition is the merge.** When the upstream PR merges and the renderer
   is resynced past it, delete the patch, its row, and any override it made redundant.

## Applying

```bash
node scripts/apply-upstream-patches.mjs            # apply all (git apply)
node scripts/apply-upstream-patches.mjs --check     # verify only; CI runs this
```

CI fails if any patch stops applying — that is the signal that a resync or an
upstream change needs the patch rebased (HM-33).

## Inventory

| Patch | Upstream PR | What it carries | Remove when |
|---|---|---|---|
| _(none yet)_ | | | |
