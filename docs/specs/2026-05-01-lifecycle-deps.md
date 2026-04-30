# PRD — VPR Lifecycle States, Item DAG, and Send-to-Done Flow

## Problem Statement

When a VPR is sent (PR pushed and created), the work it represents is not closed
out. The Azure DevOps work item stays in its prior state, the local meta record
stays partially populated, and nothing distinguishes "PR is up for review" from
"PR has merged". As a result:

- `plan-pull` re-pulls tickets that have already been pushed, because dedup
  only checks `meta.items` and items disappear from there once all their VPRs
  ship to `meta.sent`.
- The Azure board does not reflect what is actually done. Humans must manually
  flip work items to Done, and there is no audit of "this VPR's PR merged at
  T".
- There is no notion of "this ticket depends on that ticket". When a parent
  work item has many children, vpr cannot recommend what to work on next, nor
  refuse a circular dependency edit, nor recompute downstream blockage when a
  PR is abandoned.
- Failed PRs (closed without merging) have no representation. The `sent`
  record looks identical to a successful PR, and downstream items that
  depended on the abandoned work continue to be treated as unblocked.
- The TUI does not give a clean affordance to merge two over-sliced VPRs
  into one, nor to move a single commit between VPRs without dropping into
  jj subcommands and risking a broken chain.

## Solution

Introduce a lifecycle state machine over items and VPRs (`hold | ready | sent
| done`), an item-level dependency DAG, and a clean send → merge → done flow
that updates Azure when work is genuinely complete.

From the user's perspective:

- After `vpr send`, the VPR is `sent`. Its row stays visible in the chain so
  reviewers can see what is in flight. The Azure work item state is unchanged.
- After PRs merge, the human runs `vpr ticket done <name>`. vpr verifies all
  VPRs in the item are sent and merged (optionally polling Azure to confirm
  merges), flips the Azure work item to Done, and stamps `itemDone: true`
  on the corresponding `sent` records. History is preserved.
- A failed PR is recorded by `vpr abandon <bm>`. Downstream items that depended
  on the abandoned work are recomputed and shown as blocked again.
- Items declare `dependsOn: [otherItemName]`. `/to-issues` populates this
  during planning; humans can edit it later. `vpr next` lists unblocked items
  in chain order. Cycles are refused at edit time.
- The TUI is the daily surface. It shows the chain in push order, ready items
  on top, hold at the bottom, sent in flight, done hidden by default. Users
  can merge adjacent VPRs, abandon failed sends, edit stories and deps,
  mark tickets done, and move single commits between VPRs with conflict-aware
  rollback.
- `plan-pull` no longer resurrects pushed-up tickets. It dedups against
  `items`, `sent`, and Azure-terminal states.

## User Stories

1. As a developer, I want `vpr send` to leave a VPR visible in the chain as
   "sent" so that I can see what is in review without losing the PR record.
2. As a developer, I want to mark an item done in one command after its PRs
   merge, so that the Azure work item flips to Done without leaving the CLI.
3. As a developer, I want vpr to refuse `vpr ticket done` when the item still
   has unsent VPRs or unmerged sent VPRs, so that I cannot accidentally close
   incomplete work.
4. As a developer, I want a `--check-merged` flag on `vpr ticket done` that
   polls Azure for each sent PR's merge state, so that I can autofill
   `mergedAt` without manual lookup.
5. As a developer, I want a `--force` override on `vpr ticket done`, so that
   I can close items whose scope shrank (e.g. a planned VPR that was no
   longer needed).
6. As a developer, I want `plan-pull` to skip work items already in `items`,
   `sent`, or in an Azure-terminal state, so that re-pulling a parent does not
   resurrect already-shipped tickets.
7. As a planner, I want each item to declare `dependsOn: [otherItem]`, so that
   I can model "backend ticket must ship before frontend ticket can branch".
8. As a planner, I want `/to-issues` to seed `dependsOn` from PRD slice order,
   so that I do not have to wire deps by hand for typical work.
9. As a developer, I want `vpr ticket edit --depends-on` to refuse adding a
   dep that would create a cycle, so that the DAG never goes circular silently.
10. As a developer, I want `vpr next` to print unblocked items sorted by chain
    depth (root first), so that I always know which item to pick up next.
11. As a developer, I want an item to count as "released" (unblocking
    downstream) the moment one of its VPRs is `sent` and not abandoned, so
    that stacked PRs can pipeline without waiting for review cycles.
12. As a developer, I want `vpr abandon <bm>` to mark a sent VPR as abandoned
    and recompute downstream block state, so that items waiting on the dead PR
    re-block until I redo the work.
13. As a developer, I want abandoned VPRs to remain in `meta.sent` with an
    `abandoned: true` flag, so that audit trail of what was sent is preserved.
14. As a developer, I want `vpr status` to default to chain (push) order with
    ready items on top, hold at the bottom, and done hidden, so that the daily
    view is tight.
15. As a developer, I want `vpr status --all` to include done and abandoned
    history, so that I can audit shipped work.
16. As a developer, I want to merge two adjacent VPRs in the same item via
    `vpr merge <src> --into <dst>`, so that I can collapse over-sliced
    chapters without manual jj squashing.
17. As a developer, I want the TUI to expose merge, abandon, ticket-done,
    story edit, and dep edit as primary actions, so that I can run the
    daily flow without dropping to the CLI.
18. As a developer, I want a TUI gesture (space-select commit, space-select
    target VPR) to move a commit between VPRs, so that I can reorganize a
    chain interactively.
19. As a developer, I want move-commit to try the move and roll back via
    `jj op restore` on conflict, so that a failed move never leaves jj in a
    broken state.
20. As a developer, I want move-commit to print conflicting hunks on
    rollback, so that I can see what blocked the move.
21. As a developer, I want move-commit to suggest VPRs the commit can move
    to cleanly, so that I can pick a non-conflicting target.
22. As a developer, I want the option to drop into vim merge from a move
    conflict, resolve, and retry, so that I can repair conflicts inline.
23. As a developer, I want existing `.vpr/meta.json` files to gain new fields
    via one-shot default-fill on first invocation, so that upgrading vpr
    does not require manual migration.
24. As a developer, I want `vpr ticket done` to keep `sent[branchName]` records
    after closing the item (with `itemDone: true`), so that PR history is not
    lost when an item closes.
25. As a developer, I want existing dangerous chain commands (`vpr move`,
    `vpr hold`) reworked to be chain-safe (validate destination, refuse
    chain-breaking moves), so that the daily TUI never leaves the chain
    invalid.
26. As a developer, I want `vpr next` and the DAG queries to be pure
    functions over state, so that they are trivial to test with fixture data.

## Implementation Decisions

### State machine

- Item-level states: `hold | ready | sent | done`.
- VPR record states are derived from container: VPR in `meta.items[name].vprs`
  is unsent; VPR in `meta.sent[bm]` is sent. Sent records gain optional
  `mergedAt`, `abandoned`, `itemDone` flags.
- An item is "released" (unblocking) when it has at least one VPR in
  `meta.sent` with `abandoned` not set.
- An item is "done" when all its VPRs are in `meta.sent` and either every
  record has `mergedAt` or `--force` was used.

### Modules

- `core/dag.mjs` — pure DAG engine and queries (deep module, see DAG
  interface below).
- `core/lifecycle.mjs` — pure derivation of item/VPR state from raw meta.
- `core/migration.mjs` — one-shot default-fill on `loadMeta`. Adds
  `dependsOn: []` to items, leaves `mergedAt`/`abandoned`/`itemDone` unset on
  existing sent records (treated as in-flight). Idempotent.
- `commands/abandon.mjs` — mark `meta.sent[bm].abandoned = true`, append
  event log entry, surface downstream items now re-blocked.
- `commands/merge.mjs` — same-item-adjacent merge. `vpr merge <src>
  --into <dst>` jj-squashes src commits into dst's bookmark, deletes src
  VPR record, keeps dst's title/story unless `--title`/`--story` override.
- `commands/move.mjs` — single-commit move between VPRs. Try via jj, roll
  back via `jj op restore` on conflict, return conflict report and
  clean-target suggestions.
- `commands/next.mjs` — calls `dag.ready(state)`, prints sorted list.
- `commands/ticket.mjs` (extend `ticketDone`) — preconditions check, optional
  Azure poll for merge state, Azure work item state flip, mark
  `itemDone: true` on sent records (instead of deleting them).
- `commands/plan-pull.mjs` (extend) — dedup against items, sent, and
  Azure-terminal-state work items.
- `providers/azure-devops.mjs` (extend) — `getPRStatus(prId)` returns
  `{ merged, mergedAt }`; `TERMINAL_STATES` constant covers Done, Closed,
  Resolved, Removed.
- `tui/` (extend) — display sort/filter, space-space move-commit gesture,
  merge action, abandon action, ticket-done action, story edit, dep edit,
  conflict resolution flow.

### `core/dag.mjs` interface

Synthesized from "design twice" comparison: an internal `analyze` engine
exposed for power users, plus a canonical set of named queries layered on
top. Queries accept either raw `state` (rebuild) or a pre-built view
(reuse), so the TUI can analyze once per render and run many queries.

```js
// Engine
export function analyze(state): { nodes, cycles, order, byWi }

// Canonical queries (state or pre-built view)
export function ready(stateOrView): ItemView[]       // unblocked + not done
export function blocked(stateOrView): ItemView[]
export function released(stateOrView): ItemView[]
export function next(stateOrView): ItemView | null   // ready[0]
export function upstream(stateOrView, name): ItemView[]
export function downstream(stateOrView, name): ItemView[]
export function status(stateOrView, name): ItemView | null
export function findByWi(stateOrView, wi): ItemView | null

// Mutation-time validator (lighter walk, no full enrichment needed)
export function wouldCycle(state, from, to): string[] | null
```

`ItemView` is a uniform shape across every query:
`{ name, wi, status, blockers, depth, vprCount, released, done, ready }`.
TUI sort/render is uniform across the result of any query.

### Dependency rules

- Item granularity only. No VPR-level deps.
- Source: `/to-issues` seeds `dependsOn` based on PRD slice order; manual
  override via `vpr ticket edit --depends-on`.
- Unblock rule: A's first non-abandoned `sent` VPR releases B (B's dep on A
  is satisfied).
- Cycles refused on edit. `wouldCycle` returns the cycle path for the error
  message.

### Failure path

- `vpr abandon <bm>` does not move the record out of `meta.sent` — it sets
  `abandoned: true`. Downstream items re-block via the same `released`
  rule. New work happens as a new VPR (no automatic recreation).

### Lifecycle visibility

- Default `vpr status` shows chain (push) order, ready items on top, sent
  inline (in-flight), hold at the bottom. Done items hidden.
- `vpr status --all` includes done and abandoned for audit.
- TUI mirrors this default; provides toggles to show done.

### Migration

One-shot default-fill in `loadMeta`. No version bump, no breaking change.
Existing sent records without `mergedAt` are treated as still-in-flight.

## Testing Decisions

A good test for these modules tests external behavior only. For pure
modules (`dag`, `lifecycle`, `migration`), that means: feed in a fixture
state, assert on returned values. For command modules, drive via the same
jj-tmpdir pattern already used in `test/`.

Modules to be tested:

- `core/dag.mjs` — exhaustive truth-table tests for every query. Cover:
  empty state, single item, linear chain, branching DAG, cycle detection,
  abandoned VPR re-blocks downstream, dangling dep names, large fan-out,
  shape consistency across `state`-input vs `view`-input. Prior art:
  `test/core/state.test.mjs` style.
- `core/lifecycle.mjs` — truth table over `(items, sent)` permutations
  asserting derived `released`, `done`, `ready` flags.
- `core/migration.mjs` — round-trip: load pre-migration fixture, assert
  default-fill, save, reload, assert idempotent.
- `commands/abandon.mjs` — integration: send a VPR in jj-tmpdir, abandon,
  assert `meta.sent[bm].abandoned === true` and downstream items re-block.
- `commands/merge.mjs` — integration: two adjacent VPRs in same item,
  merge, assert single bookmark, dst's title/story preserved, src record
  deleted, jj graph clean.
- `commands/move.mjs` — integration: clean move succeeds; conflicting
  move rolls back via `jj op restore` and returns conflict report.
- `commands/ticket.mjs` (done) — integration: refuses with unsent VPRs;
  `--check-merged` polls provider stub; success flips Azure state and
  stamps `itemDone: true` on sent records.
- `commands/plan-pull.mjs` (extended) — fixture parent with one already-sent
  child, one merged child (Azure terminal), one fresh child — asserts only
  fresh child is created.

Provider and TUI: manual smoke tests. The dangerous chain-edit ops
(`move`, `merge`) get the most rigorous integration coverage because they
mutate jj state.

## Out of Scope

- VPR-level dependencies (cross-item, cross-VPR). Item-level only.
- Cross-repo dependencies. State blob is single-repo.
- Streaming or incremental DAG updates. Eager rebuild per query is fine at
  vpr scale (hundreds of items).
- Webhook or daemon-driven merge detection. Manual `vpr ticket done` (with
  optional `--check-merged` poll) only.
- A general-purpose graph library API. The DAG module is curated to vpr's
  use cases; `analyze` is the escape hatch for one-off custom queries.
- Mid-chain VPR removal that orphans descendants. Use `vpr remove` + manual
  jj rebase.
- Anything requiring a meta schema version bump. Migration is default-fill
  only.

## Further Notes

- The TUI gains the most surface area in this PRD. It becomes the primary
  visualization of state and the primary surface for safe edits. Dangerous
  operations are reworked to be chain-safe rather than removed entirely —
  they remain accessible but no longer leave jj in a broken state on
  failure.
- "Released" semantics deliberately favor pipelining over safety. A `sent`
  VPR (PR up, not merged) unblocks downstream items so stacked-PR review
  can run concurrently. If A's PR is later abandoned, downstream items
  re-block; this matches in-chain rework risk.
- The DAG module's polymorphic `state | view` input is a deliberate cost:
  it lets TUI render in one analyze() call, while CLI one-shots remain
  ergonomic. The shared `ItemView` shape across every query keeps callers
  uniform.
- The `wouldCycle` function is intentionally separate from `analyze`. Cycle
  checks happen at mutation time and don't need full enrichment; keeping
  them separate avoids paying for `nodes`/`order` computation on every
  edit.
- Provider config in this repo is `provider: none` so this PRD cannot be
  submitted as an Azure DevOps work item from vpr itself. Save location:
  `docs/specs/2026-05-01-lifecycle-deps.md`.
