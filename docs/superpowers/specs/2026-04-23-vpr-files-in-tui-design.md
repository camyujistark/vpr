# VPR file list in TUI right pane

## Problem

When a VPR is selected in the TUI tree, the right pane shows metadata
(`Bookmark`, `Commits`, `Sent`, `Conflict`), then `Story`, then `Output`. The
user cannot see at a glance which files the VPR touches without expanding to a
specific commit. They want a deduped, VPR-wide files list visible in the VPR
view.

## Solution

Insert a new `Files (N)` section in the VPR right-pane block, between the
`Conflict:` line and the `Story` section.

### Layout

```
VPR: <title>
Bookmark: <bookmark>
Commits: 3
Sent: no
Conflict: no

─── Files (7) ───
M src/tui/render.mjs
M src/tui/tui.mjs
A src/tui/files.mjs
D old/legacy.mjs
…

─── Story ───
…
```

### Aggregation

A new helper `getVprFiles(changeIds)` in `src/core/jj.mjs`:

1. For each `changeId`, call existing `getFiles(changeId)` (returns lines like
   `"M src/tui/render.mjs"`).
2. Parse each line into `{ status, path }` (split on first whitespace).
3. Reduce into a `Map<path, status>`. When a path appears multiple times, keep
   the strongest status by precedence: **A > D > M > R > C > anything else**.
4. Return an array of `"<status> <path>"` strings sorted by path.

### Edge cases

- VPR with zero commits — omit the `Files` section entirely.
- `getFiles()` throws on a commit — skip that commit silently (matches the
  existing try/catch pattern in `buildRightContent`).
- Rename lines (`R old -> new`) — keep verbatim; do not attempt to merge with
  the source or destination path entries.

## Scope

- New helper in `src/core/jj.mjs` (~15 lines).
- New section block in `src/tui/tui.mjs` `buildRightContent()` VPR branch
  (~8 lines).
- Optional unit test for the dedup/precedence logic.

## Non-goals

- No diff preview at the VPR level (single-commit diff view is unchanged).
- No interactive expand/collapse of the files list.
- No clickable jump from a file row to its diff.
