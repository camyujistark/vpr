# Project agent memory

Project-intrinsic agent knowledge for `vpr` (Virtual Pull Request manager):
build, test, architecture, and sharp-edge notes that travel with the code.

## Build / test

- Run tests with **`npm test`** — it globs `test/*/*.test.mjs`. Plain
  `node --test test/` fails (wrong glob → MODULE_NOT_FOUND).
- Run one file: `node --test test/commands/<name>.test.mjs`.
- Pure ESM (`"type": "module"`), Node's built-in test runner, no build step.

## Architecture

- **VCS backend seam** (`src/core/vcs.mjs`): `createVcs()` returns a backend
  (`jjBackend` in `jj.mjs`, `gitBackend` in `git.mjs`) implementing the
  `VcsBackend` typedef. **git (v2) is the default**; jj (v1) is opt-in
  (jj-colocated repos auto-detect via `.jj/`, or pin with `VPR_VCS=jj` /
  `.vpr/config.json` `"vcs":"jj"`).
- **State split:** the backend owns the commit graph; `.vpr/meta.json` owns
  metadata (items, VPR stories/output, `sent` map, event log). Bookmark/branch
  name is the join key. `.vpr/` is gitignored via `.git/info/exclude`.
- **Chain ordering** lives in `src/core/state.mjs` `computeChainState()` — it
  decorates each VPR with `blocked`/`nextUp`/`cascadeTarget`. `send` reads
  `cascadeTarget` to target each PR at the branch below it in the stack.

## Sharp edges

- **Planning must be commit-free.** Materialize slices as branch POINTERS, never
  empty scaffold commits — scaffolds ride in every PR's commit list and can't be
  stripped once a branch is checked out in a worktree. `vpr plan slices` and the
  pointer path use `moveBookmark` (`git branch --force` / `jj bookmark set`),
  both pure ref updates. jj's `addBookmark` still does a `jj new` empty-commit
  dance on collision (needed for the partition walk of *worked* slices) — don't
  route planning through it.
- **`test/skills/*.test.mjs` read files OUTSIDE the repo** (`~/.claude/skills/`).
  `vpr-skill.test.mjs` can fail purely from skill-doc drift on the machine — it
  is not a code regression. Don't "fix" it by editing files outside the worktree.
- **git worktrees:** `bin/vpr.mjs` refuses to run inside a `.git/worktrees/*`
  checkout (jj can't colocate there). Run vpr from the primary checkout.
- **`send` gates** on a non-empty story and on no conflicts, and refuses to send
  a VPR whose predecessor is unsent (sequential push) or that would drag another
  VPR's commits into the PR (stowaway check; `--force` overrides).

## Send flow (send.mjs)

- `send(query)` — one slice: gate → rename to `feat/<wi>-<slug>` → push →
  `provider.createPR(...)` → move VPR to `meta.sent`. Branch name via
  `sliceBranchName()` (single source of truth).
- `sendAll({...})` — batch: loop `resolveNextUpBookmark` → `send` oldest-first;
  stop at first blocker, skip already-sent on re-run. `dryRun` previews only.
- Locked planning decisions in `.vpr/config.json` (`vpr plan lock` /
  `vpr init` flags): `provider`, `workItemModel` (`one-pbi` links the feature
  PBI `item.parentWi` on every PR; `per-slice` links the slice's own wi),
  `storySource`. `resolveWorkItemId()` in `plan-lock.mjs` applies the model.
