# Changelog

## v0.2 — Plan-first, sync-aware, renamed to `ship` (in progress)

### Direction

v0.1 was a post-hoc commit grouper: commit freely, then slice commits into VPRs, then push. v0.2 flips this — **you declare the plan first, then execute against it.** The binary renames from `vpr` to `ship` to reflect the new grain.

The plan lives in one human-readable file: `plan.md`. Three heading levels mirror the Azure DevOps hierarchy: Epic (PBI) → Task → PR. Each section has two labeled fields: `Story:` (your notes) and `Description:` (AI-polished prose). The tool never touches Story; `ship gen` writes Description.

Existing Azure backlogs are first-class. `ship plan pull <pbi>` imports a PBI and its Tasks into `plan.md` — you plan against real work without retyping it. `ship sync` pushes Description changes up and pulls remote changes down, with merge markers on conflict.

### What's new

- **`plan.md`** — canonical file, human-readable, single source of truth. Replaces `meta.json`.
- **Three-level structure** — Epic / Task / PR as H1 / H2 / H3. Each level has its own Story + Description and gen command.
- **`ship plan pull`** — import existing Azure PBIs and their child Tasks.
- **`ship sync`** — bidirectional description sync with Azure, conflict-aware.
- **`ship gen {epic|task|pr}`** — polish Description at any level with context appropriate to that level.
- **`$EDITOR` review** on every AI write — no silent overwrites.
- **LLM-agnostic** — shells out to `claude -p` by default, `$SHIP_LLM` overrides, `--pipe` for DIY.

### What's removed

- `meta.json` — state lives in `plan.md` + `.ship-sync.json` + jj.
- `vpr add` — PRs are declared in `plan.md` before commits exist, not bolted on after.
- `vpr ticket new` (create-only) — replaced by `ship plan pull` for existing backlogs; greenfield epics are hand-authored.
- Event log (`actor: claude` entries) — `git log` covers commits; Claude Code memory covers cross-session context.
- Post-hoc commit-to-VPR assignment — you write a PR's `commits:` range when you're ready, not after the fact.
- Item-as-parent-of-VPRs concept — absorbed into the Epic/Task hierarchy that maps directly to Azure.
- TUI in MVP — phase-2 as a pure dashboard that shells out to the CLI.

### What survives

- jj as the commit engine, especially for stack maintenance under PR feedback.
- The story → description AI generation pattern you liked in v0.1, now available at three levels.
- The send ceremony (bookmark renames, stacked PR creation, WI linking), simplified because the plan is already linear per PR.
- `gh` / `az` providers.

### Design laws that came out of the v0.2 grill

1. Every layer justifies itself against the one-sentence problem.
2. Nothing hides state the CLI can't read.
3. The TUI adds; it never owns, and it never hinders.
4. The file is truth. Tools are verbs against the file.
5. External tools are shelled out; no vendor lock.
6. Human review gates every AI write.

See `docs/specs/2026-04-25-ship-v0.2-design.md` for the full design.

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
