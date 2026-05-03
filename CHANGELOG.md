# Changelog

## v2.1.0 — Lifecycle states, DAG, and surgical moves

### What's new

#### Item dependency graph (DAG)

Items can now declare dependencies on each other. VPR tracks which items are blocked, which are ready, and computes topological order.

```bash
vpr ticket edit my-item --depends-on other-item    # add dependency
vpr ticket edit my-item --remove-depends-on other  # remove
vpr next                                           # print ready items sorted by depth
```

`vpr next` prints items with no unsatisfied dependencies — sorted by chain depth, then name. Cycle detection runs before save; circular dependencies are rejected with the cycle path.

`vpr status` now groups items by lifecycle state: ready items first (marked `▶`), then in-flight (shows open PR count), then held, then done (hidden by default — use `--all` to show). Blockers and chain depth appear on each item header.

#### Lifecycle states

Items move through a derived lifecycle based on their sent records:

- **ready** — not done, all deps released
- **in-flight** — has at least one sent record that isn't `itemDone`
- **done** — every sent record has `itemDone: true`
- **held** — flagged as on-hold

`vpr ticket done <item>` formally closes an item: stamps `itemDone` on all sent records, calls the provider to mark the work item resolved. Supports `--check-merged` (polls provider for PR merge status before closing) and `--force` (bypasses preconditions).

#### Abandon a VPR

```bash
vpr abandon <vpr>
```

Marks a sent VPR as abandoned — it no longer counts as blocking downstream items. Appends a `vpr.abandon` event to the event log.

#### Merge two VPRs

```bash
vpr merge <src> --into <dst>
```

Squashes a source VPR into an adjacent destination VPR within the same item. Preserves the destination's title and story. Rejects cross-item merges and non-adjacent merges. Uses jj squash when available, falls back to git plumbing.

#### Move a commit (requires jj)

```bash
vpr move <changeId> --to <vpr>
```

Rebases a single commit into a different VPR using `jj rebase -r`. Captures the jj op-log before the move; rolls back automatically on conflict and returns the conflict file paths. Returns clean-target suggestions if the direct target conflicts.

#### Meta-only VPRs

VPRs can now exist in metadata without a jj bookmark — useful for planning ahead. `vpr add` registers the VPR in meta without creating a bookmark; `vpr status` shows `planned, no work yet` for these.

#### Migration

`vpr migrate` converts legacy anchor-commit VPRs to the new meta-only format. Dry-run by default — pass `--apply` to write changes. Writes a backup before converting.

#### Schema migration

`loadMeta()` now runs `migrateMeta()` on every load and writes back only if the schema changed. Adds `dependsOn: []` to items that predate the DAG feature. Idempotent.

#### plan-pull dedup

`vpr plan-pull` skips work items that are already in `sent` or in a terminal provider state (completed, closed, resolved). Prevents duplicate VPRs from being created for already-shipped work.

#### jj auto-export

After any operation that mutates bookmarks or refs, VPR automatically calls `jj git export` when jj is available — keeping the git index in sync without manual intervention.

### CLI additions

```bash
vpr next                               # print ready items (depth-sorted)
vpr ticket edit --depends-on <items>   # add deps (comma-separated)
vpr ticket edit --remove-depends-on    # remove deps
vpr ticket done <item>                 # close item, stamp itemDone
vpr ticket done --check-merged         # poll provider for merge status first
vpr ticket done --force                # bypass preconditions
vpr abandon <vpr>                      # mark sent VPR as abandoned
vpr merge <src> --into <dst>           # squash VPRs together
vpr move <changeId> --to <vpr>         # move commit to different VPR (jj required)
vpr migrate                            # convert legacy anchor-commit VPRs
vpr status --all                       # include done items
```

### meta.json additions

```json
{
  "items": {
    "my-item": {
      "dependsOn": ["other-item"],
      "vprs": { ... }
    }
  },
  "sent": {
    "feat/123-slug": {
      "prId": 4952,
      "itemName": "my-item",
      "itemDone": true,
      "mergedAt": "2026-05-04T...",
      "abandoned": false
    }
  }
}
```

---

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
