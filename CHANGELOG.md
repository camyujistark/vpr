# Changelog

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
