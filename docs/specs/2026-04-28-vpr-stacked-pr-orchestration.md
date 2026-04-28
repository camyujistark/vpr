# VPR Stacked PR Orchestration

## Problem Statement

Working on a multi-PR feature in the transit-platform monorepo currently leaves too many ways to make a mess. PRs accidentally pull commits from unrelated parallel work into their diffs (the recent favicon PR shipped fleet-sources changes by accident). PR descriptions are generated from commits alone, missing the broader product context (user stories, problem framing, acceptance criteria) — so the descriptions read mechanical and don't anchor to what the work was supposed to achieve. The send process requires the human to remember target branches, manually pick the right base, write stories, run generate, push — every step is a chance to forget something. And held work (e.g. fleet-sources, parked behind a different priority) is just a metadata flag with no teeth: pushing any other PR happily pulls the held commits into its ancestry.

The user wants to run a full feature end-to-end — design discussion → PRD → slice tickets → implementation → QA → cascade-pushed PRs — without juggling state in their head, and without the agent silently fabricating content that should have come from the human.

## Solution

A vertically-integrated VPR pipeline where:

1. Held items are physically detached from the active commit chain (sidebranch off the boundary), so they cannot pollute other PRs' diffs.
2. `vpr send` (no args) walks the chain bottom-up — refuses to skip ahead, names the blocker, auto-resolves the cascade target.
3. Send opens the user's editor with a story prompt enriched by parent PRD context (user stories, problem statement) and slice context (acceptance criteria). User edits story → vpr re-generates output → user reviews → confirms → pushes.
4. Generation pulls the parent PRD's description from Azure (cached, refreshable) so the output is grounded in the original product intent, not just commit subjects.
5. The TUI shows the chain state at a glance — what's next, what's blocked by what, where each PR will target — so the human always knows where they are.
6. Agent contract enforces "always ask the human for the story narrative" via a vpr skill (not project CLAUDE.md), and the agent path mirrors the human path with explicit two-step generate-then-send so the user always reviews output before it ships.

The flow integrates with existing skills: `/grill-me` → `/ubiquitous-language` → `/to-prd` (PBI = PRD) → `/to-issues` (Tasks = slices, linked to PBI) → `/design-an-interface` (per-slice) → ralph + `/tdd` (per-slice) → QA round → `vpr send` loop.

## User Stories

1. As a developer, I want to push a PR for one VPR without dragging unrelated parallel work into the diff, so that reviewers see only the changes I'm actually proposing.
2. As a developer, I want to mark unfinished work as "held" and have it physically detached from my active chain, so that I can keep working on other features without tripping over the held commits.
3. As a developer, I want `vpr send` to refuse if there are unsent VPRs below the one I'm targeting, so that I never accidentally bypass the cascade order.
4. As a developer, I want `vpr send` (no args) to pick the next sendable VPR automatically, so that I don't have to remember which bookmark is next.
5. As a developer, I want the TUI to show me which VPR is next-up and which are blocked, so that I can see the chain state at a glance without running multiple commands.
6. As a developer, I want each blocked VPR labelled with the specific blocker that's keeping it from shipping, so that I know exactly what to send first.
7. As a developer, I want the cascade target (the previous PR's branch) auto-resolved when I send, so that I never push a PR with the wrong base by accident.
8. As a developer, I want held items skipped over in cascade resolution, so that the next-up VPR's target is the right active-chain branch, not a held sidebranch.
9. As a developer, I want `vpr send` to open my editor with the current story so I can refine the narrative, so that the PR description reads in my voice and not the LLM's.
10. As a developer, I want the editor buffer to include the work item's user stories and acceptance criteria as context comments, so that I'm reminded of the original intent while writing the story.
11. As a developer, I want the editor buffer to include the commits and the last-generated output as context, so that I can see what the LLM produced last time and adjust my story accordingly.
12. As a developer, I want the title editable in the same buffer as the story, so that I can fix wording without running a separate command.
13. As a developer, I want a re-generate to happen automatically when I save with a changed story, so that I can iterate on the narrative without manually invoking generate.
14. As a developer, I want a `[y/N/e]` prompt after each regeneration, so that I can ship, abandon, or re-edit explicitly without a sentinel value.
15. As a developer, I want already-prepared VPRs to skip the editor and go straight to the y/N/e preview, so that I don't waste a round-trip when the story is already good.
16. As a developer, I want an empty/unchanged story to abandon the send, so that escaping the editor never accidentally pushes garbage.
17. As a developer, I want the LLM prompt to include the parent PRD's description (user stories, problem statement), so that the generated output is grounded in product intent rather than just commit subjects.
18. As a developer, I want the LLM prompt to include the slice ticket's description (what to build, acceptance criteria), so that the output reflects this PR's specific scope.
19. As a developer, I want work item descriptions cached locally in `meta.json`, so that generate is fast and offline-friendly.
20. As a developer, I want a `vpr ticket refresh <name>` command, so that I can pull the latest WI description when it's been edited in Azure.
21. As a developer, I want a `vpr ticket update <name>` command, so that I can push a refined description back to the Azure work item when I improve it locally.
22. As a developer, I want the parent WI ID stored on each item, so that the parent PRD context can be pulled at generate time.
23. As an agent, I want `vpr send` to refuse with a clear single-line error naming what's missing or blocking, so that I can parse it and decide what to do next.
24. As an agent, I want a two-step path (`vpr generate --story "..."` then `vpr send`) for non-TTY use, so that I can show the generated output to the user for approval before anything ships.
25. As an agent, I want a `vpr` skill that codifies the workflow rules, so that I always ask the user for the story, never fabricate it, and never skip the user-review step.
26. As a developer, I want `/to-prd` to create a PBI in Azure with the full PRD as its description, so that the work-item hierarchy mirrors the product hierarchy.
27. As a developer, I want `/to-issues` to create child Tasks linked to the parent PBI, with each Task's description holding the slice spec, so that vpr can pull both parent and child contexts at generate time.
28. As a developer, I want the TUI cursor to auto-jump to the next-up VPR when I open it, so that I see the actionable item immediately.
29. As a developer, I want the TUI to render `▶`, `◦`, `✓`, `⏸` consistently across items, so that the chain state reads at a glance.
30. As a developer, I want `vpr send` to display the resolved target before pushing, so that I can sanity-check the cascade base.
31. As a developer, I want `vpr ticket hold <name>` to be idempotent, so that re-running it on already-detached items is a safe no-op.
32. As a developer, I want a `vpr` skill that integrates with `/grill-me`, `/ubiquitous-language`, `/to-prd`, `/to-issues`, `/design-an-interface`, `/tdd`, and a QA round, so that the full feature pipeline is a known, reproducible sequence.
33. As a developer, I want held items' commits preserved (just relocated to a sidebranch), so that I can come back to the work later by un-holding without re-implementing.
34. As a developer, I want detach to use the actual boundary commit (not trunk) when needed, so that the held item's dependencies are preserved and the rebase doesn't introduce conflicts.
35. As a developer, I want sequential enforcement to apply uniformly to CLI and TUI, so that there's no "loophole" path that skips the blocker check.

## Implementation Decisions

**Hierarchy in Azure DevOps**: PBI = PRD; Tasks = slices/PRs (one per VPR). Aligns with the existing project pattern (`safron-mvp2` PBI #17148 with child Tasks).

**Source of truth for chain state**: a single pure function in `core/state.mjs` computes per-VPR `blocked`, `nextUp`, `blockedBy`, `cascadeTarget`, consumed identically by CLI commands, TUI render, and the `vpr send` orchestrator. Single source of truth means the CLI, the TUI, and the agent's parseable error all describe the chain identically.

**Detach-on-hold algorithm** (already implemented):
- `roots(itemBookmarks)..heads(itemBookmarks)` is the wrong range — it misses unbookmarked predecessor commits that conceptually belong to the item.
- Correct range: `(boundary)..heads(itemBookmarks)` where `boundary = heads((::roots(itemBookmarks)) & (otherItemBookmarks | trunk() | remote_bookmarks()))` — the topmost ancestor that is itself an anchor.
- Rebase destination is `boundary`, not `trunk()`, so the held item stays on its actual base and active-chain descendants reparent onto the same boundary as siblings.
- `jj rebase -r '<range>' -d '<boundary>'` semantics handle the reparenting automatically.

**Cascade target resolution**:
- For the next-unsent VPR, target = the immediately-previous *sent* VPR's branch from `meta.sent`, walking the active chain.
- Held items are skipped (their bookmarks are off-chain on a sidebranch).
- Falls back to `main` if no sent VPRs exist below.

**Sequential enforcement**: enforced in `commands/send.mjs` and surfaced in TUI render. CLI exits non-zero with `Cannot send <bookmark>: send <blocker> first`. TUI shows `◦ → <blocker-bookmark>` next to blocked VPRs.

**Editor buffer format**:
- Editable: `--- Title ---` and `--- Story ---` sections.
- Read-only (comments, ignored on parse): commits list, last-generated output, work-item description excerpts.
- Lines starting with `#` are stripped on save.

**Editor flow loop**: open → save → regen-if-story-changed → preview → `[y/N/e]` → branch:
- `y` → push (uses cascade target).
- `N` → abandon, return to TUI / shell.
- `e` → re-open editor → loop.

**Empty story = abandon**: matches `git commit` semantics.

**Already-prepared VPRs**: skip editor, go straight to preview + `[y/N/e]` prompt.

**Generate prompt structure**:
```
PARENT PRD (PBI #<parentWi>): <parentWiTitle>
<parentWiDescription>

THIS SLICE (Task #<wi>): <wiTitle>
<wiDescription>

VPR title: <vpr.title>
Story: <vpr.story>
Commits:
  - ...
```

**Schema additions to `meta.items`**:
- `wiDescription` — cached child Task description (the slice spec).
- `parentWi` — parent PBI work item ID.
- `parentWiTitle` — cached for display.
- `parentWiDescription` — cached parent PRD body.

**Sync commands**:
- `vpr ticket refresh <name>` — Azure → local for both child and parent descriptions; one provider call each.
- `vpr ticket update <name>` — local → Azure for the child Task description (parent PBI usually edited directly in Azure or via `/to-prd`).

**Agent contract** (codified in `~/.claude/skills/vpr/SKILL.md`, not project CLAUDE.md):
- Always ask the human for the story narrative; never fabricate.
- Two-step generate-then-send: `vpr generate --story "..."` → human approves output → `vpr send`.
- Sequential push only — never override blocked-state warnings.
- Refresh ticket data via `vpr ticket refresh` if the WI is suspected stale.

**TUI rendering**:
- `▶ ·` (white) — next-up VPR, sendable.
- `◦` (dim) — blocked VPR; right-aligned label `→ <previous-bookmark>`.
- `✓` (green) — sent VPR; right-aligned label `→ PR #<id>` and target.
- `⏸` (yellow) — held item; right-aligned label `[held — detached]`.
- Cursor auto-jumps to the next-up VPR on TUI open.

**Provider extension**: `azure-devops.mjs` gains `updateWorkItemDescription(id, body)` for the local→Azure update path. Existing `getWorkItem` already returns description.

**Backwards compatibility**: meta.json items missing the new fields are treated as having empty values; no destructive migration needed.

## Testing Decisions

**What makes a good test in this codebase**: tests verify behavior through public interfaces (the exported function or CLI surface), not implementation details. Tests should describe what the system does, not how. Integration-style — exercise real code paths through public APIs, no mocking of internal collaborators. Prior art: `test/core/state.test.mjs`, `test/commands/ticket.test.mjs`.

**Modules to test (priority order)**:

1. **Chain state computer** (extends `core/state.mjs`) — pure function, lots of branches (sent / unsent / held / blocked / cascade resolution / fallback to main). High value. Test inputs: synthetic meta + bookmark sets; outputs: enriched per-VPR state with assertions on `blocked`, `nextUp`, `blockedBy`, `cascadeTarget`. Prior art: `test/core/state.test.mjs`.
2. **Generate prompt builder** (extends `commands/generate.mjs`) — pure function, regression-prone. Test that the prompt includes parent PRD when present, falls back gracefully when missing, escapes special characters in user content, and renders commits as a bulleted list.
3. **Editor buffer parser** (small, in `tui/editor.mjs`) — pure, edge cases around comment stripping, blank sections, and special characters. Test with synthetic buffers: with/without title section, with/without story, with `#` lines mid-story, with `--- Title ---` markers in story content (should not be parsed as section headers).
4. **Detach-on-hold** (already done) — already validated manually on real data; should add fixture-based unit tests for `detachItem()` covering: held with no other items, held with overlap to other items (already-detached), held with unbookmarked predecessor, held at top vs middle vs bottom of chain. Prior art: `test/commands/ticket.test.mjs`.
5. **Send orchestrator** (new `commands/send-flow.mjs`) — light integration test using a mock provider and a stub editor. Verify: blocked refusal exits non-zero, no-args picks next-unsent, cascade target resolved correctly, editor flow loops on `e`, abandons on `N`, pushes on `y`. Prior art: `test/commands/send.test.mjs`.
6. **Provider sync paths** (`commands/ticket.mjs` refresh + update) — integration with mock provider:
   - `refresh` overwrites local fields.
   - `update` calls `updateWorkItemDescription` with current local description.
   - Both are no-ops if the WI isn't attached (item.wi unset).
7. **TUI rendering** (`tui/render.mjs`) — snapshot tests for new icons + target labels + auto-jump cursor logic. Prior art: `test/tui/tree.test.mjs`.

**Tests NOT being written**:
- No tests for the LLM call itself (generate is stubbed at the executor boundary; we test the prompt-builder output, not what the LLM returns).
- No tests for the editor shell-out (covered by manual smoke test; `openEditor` already exists and works).
- No tests for jj internals (we trust jj's rebase semantics; covered by the manual fleet-sources detach test).

## Out of Scope

- A custom in-TUI multiline text editor — TUI shouldn't be essential to the send flow; `$EDITOR` shell-out is the editing path.
- Auto-chaining `vpr send --all` to push the entire stack in one command — each PR is a real-world side effect, one-at-a-time gives a stop-and-look moment.
- Automatic up-front WI creation by `/to-issues` — WIs are created lazily at `vpr send` time, matching the existing to-issues skill convention; the user can opt in to up-front creation per the skill's own override path.
- Bidirectional auto-sync of work item state during normal operation — refresh and update are explicit user-initiated commands; magic background sync invites surprises.
- Hand-editing the generated output — output is always regenerate-only, the story field is the lever; user edits story, output re-renders.
- Pure-git providers — current scope is jj-colocated; pure-git fallback is a follow-up.

## Further Notes

- The detach-on-hold portion is **already implemented and committed** (`vpr` repo commit `c72bd2a`, "feat(ticket): hold detaches item commits onto trunk"). It's been validated against the real fleet-sources situation in the transit-platform repo, with conflict-free detach onto the boundary commit. The favicon PR was force-pushed with the cleaned ancestry.
- The vpr v2 design doc at `docs/specs/2026-04-06-vpr-v2-design.md` is the foundation; this PRD extends v2 with the workflow orchestration layer above it. Concepts (Item, VPR, jj managed by user) carry over unchanged.
- The integration with `/grill-me`, `/ubiquitous-language`, `/to-prd`, `/to-issues`, `/design-an-interface`, `/tdd` skills is *coordination*, not modification — those skills are not changed. `/to-issues` may need a small update later to write `parentWi` into vpr meta when it creates items, but that's a separate slice.
- The `vpr` skill should be created at `~/.claude/skills/vpr/SKILL.md`, not inside the project's CLAUDE.md, so it travels with the user across all projects using vpr.
- Build order from the grill remains: ticket sync → generate prompt → state computer → CLI send → editor flow → TUI updates → vpr skill. Each step ships a working piece.
- The full pipeline (`/grill-me` → `/ubiquitous-language` → `/to-prd` → `/to-issues` → `/design-an-interface` → ralph + `/tdd` → QA → `vpr send`) is documented as a recommended workflow in the vpr skill, not enforced by the tool. Each step can be invoked independently for partial use.
