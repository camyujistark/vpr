# Changelog

## Unreleased — vpr-flow improvements (map-url-facets send retro)

Three bake-ins from the map-url-facets send retro (PBI 17570), removing real
friction from the plan → send flow:

- **Pointer-based slice materialization.** `vpr plan slices "A" "B" ...`
  create-or-moves one branch pointer per approved slice in a single call,
  anchored at the chain base — a pure ref update that never writes a commit.
  Previously slices were anchored with empty scaffold commits that rode in every
  PR's commit list and couldn't be stripped once a branch was checked out in its
  own worktree. Idempotent.
- **Batch send.** `vpr send --all` loops the chain oldest-first and, per slice,
  gates → pushes `feat/<wi>-<slug>` → creates the PR with the work item linked →
  chains onto the previous slice's branch → records in meta. Stops at the first
  failing gate and skips already-sent slices on re-run. `--all --dry-run`
  previews the plan. Automates the hand-cranked sequential send.
- **Lock decisions at planning.** `vpr plan lock` (and `vpr init` flags) persist
  `provider`, `workItemModel` (`one-pbi` | `per-slice`), and `storySource` into
  `.vpr/config.json` at to-prd/to-issues time so send is mechanical. `one-pbi`
  links the feature PBI (item.parentWi) on every slice's PR; `per-slice`
  (default) links each slice's own work item.

## Unreleased — git backend (v2) is now the default

VPR now runs on plain **git** by default, behind a versioned, reversible backend
selector (`src/core/vcs.mjs`). A VPR is a git branch; the chain is linear
ancestry; restack is `git rebase --onto` (move) + `git reset --soft` (recompose,
via `vpr recompose`); `vpr send` pushes with `--force-with-lease`.

Backend precedence: explicit arg → `VPR_VCS` env → `.vpr/config.json` `"vcs"` →
jj-colocated repo (`.jj/`) ⇒ jj → **default `git`**. **git (v2) is the active
default;** jj (v1) is opt-in (colocated repos or explicit pin) and is not removed.

Revert to jj is one line — `VPR_VCS=jj` (session) or `"vcs":"jj"` in
`.vpr/config.json` (per-repo). `vpr init --git` bootstraps a git-only workspace.

Some jj-only in-place restack conveniences (single-commit reorder with
auto-reparent, split, interactive rebase, hold/detach) are not yet ported to git;
in git mode use plain git plus `vpr recompose`.

## v2.0.0 — Parallel by default

### What changed

v1 assumed your work is a single line — commit A, then B, then C, all stacked. When you wanted to reorganize, you had to shuffle commits in that one line. If two commits touched the same file, shuffling caused conflicts. The tool fought jj instead of working with it.

v2 lets your work live as parallel branches — each ticket is its own independent branch. Your Ding Convertor work doesn't touch your transit.sh work. You organize freely within each ticket, and only when you're ready to push does VPR stitch them into a chain of PRs.

The key insight: **organizing and pushing are separate steps.** During development, keep things apart so they don't conflict. At push time, combine them into the story your reviewers need to see.

### New concepts

- **Items** — work items / tickets. Each is a parallel branch. `vpr ticket new "Ding Convertor"`
- **VPRs** — virtual pull requests within an item. Each is a bookmark marking a PR boundary. `vpr add "Scaffold"`
- **Story** — your narrative for each VPR. What it does, why, what to look for.
- **Output** — AI-generated PR description from your story + the actual commits/diffs.

### New commands

- `vpr ticket new/list/edit/done` — manage items
- `vpr add` — create a VPR within an item
- `vpr edit --story` — write the PR narrative
- `vpr generate` — AI generates PR description from story + code
- `vpr send` — linearize + push + create PRs (one at a time)

### Breaking changes

- Fresh rewrite — v1 meta.json is not compatible
- No more TP indexes during development (assigned at send time)
- No more linear chain assumptions
- TUI restructured: tree view, vim-based editing
- `vpr new` replaced by `vpr ticket new` (items) + `vpr add` (VPRs)

### What we learned from v1

- Forcing a linear chain causes cascading conflicts when commits touch the same files
- Auto-renumbering indexes creates drift between VPR metadata and jj's graph
- The tool should read jj's state, not mirror or fight it
- Small commits that modify the same file across the chain are the root cause of conflicts — parallel branches eliminate this
- Conflicts are first-class in jj — resolve them, don't try to prevent them by restructuring
