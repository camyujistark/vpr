# VPR v2 Design Spec

## Problem

VPR v1 forced a single linear chain model. This caused cascading conflicts when reordering, drifting TP indexes, and confusion between the jj graph and VPR metadata. The tool got in the way instead of helping.

## Goal

VPR v2: a thin metadata + push automation layer on top of jj. Parallel items during development, linearize only at push time. The tool helps you plan, organize, and narrate your PRs — it doesn't manage jj's graph.

## Concepts

- **Item** — a work item / ticket. The big picture. Parallel branch off trunk.
- **VPR** — a virtual pull request within an item. A bookmark that marks the PR boundary.
- **Commits** — the raw work inside each VPR. Managed by jj, not VPR.

Items are parallel. VPRs within an item are linear. At push time, items are linearized into a stacked PR chain.

## Data Model

### meta.json

```json
{
  "items": {
    "ding-app": {
      "wi": 17065,
      "wiTitle": "Ding Convertor app",
      "vprs": {
        "scaffold": {
          "prTitle": "Scaffold",
          "prPrompt": "Sets up the app shell with auth...",
          "prBody": null
        },
        "components": {
          "prTitle": "Components",
          "prPrompt": "Ports AudioPlayer, Uploader...",
          "prBody": "## Summary\n..."
        }
      }
    }
  },
  "hold": [],
  "sent": {
    "feat/17065-ding-scaffold": { "prId": 4952 }
  },
  "eventLog": [
    { "ts": "2026-04-06T...", "actor": "claude", "action": "add", "item": "ding-app", "vpr": "scaffold" },
    { "ts": "2026-04-06T...", "actor": "tui", "action": "squash", "changeId": "abc123" }
  ]
}
```

### Source of truth

- **jj owns the graph** — commits, bookmarks, parent-child, conflicts
- **meta.json owns the metadata** — item titles, VPR stories, PR descriptions, event log
- **Bookmark names are the join key** — `vpr/{item}/{vpr-name}`
- **No TP indexes during development** — assigned at send time only
- **No graph mirroring** — VPR reads jj's state, never caches or duplicates it

### Bookmark convention

During development, bookmarks are simple names:
```
scaffold                         simple jj bookmark
components
transit-idempotent
```

At `vpr send`, bookmarks are renamed with the work item ID:
```
scaffold  →  feat/17065-ding-scaffold
components → feat/17065-ding-components
```

After send, the VPR entry moves from `items` to `sent` and the meta is cleaned up. Fresh slate for new work.

### meta.json after send

```json
{
  "items": {},
  "sent": {
    "feat/17065-ding-scaffold": { "prId": 4952 },
    "feat/17065-ding-components": { "prId": 4953 }
  }
}
```

## Architecture

```
vpr/
├── bin/vpr.mjs                    CLI entry point
├── src/
│   ├── core/
│   │   ├── state.mjs              read jj + meta, build unified state
│   │   ├── meta.mjs               read/write .vpr/meta.json
│   │   └── jj.mjs                 jj subprocess helpers
│   ├── commands/
│   │   ├── ticket.mjs             vpr ticket new/list/edit/done
│   │   ├── add.mjs                vpr add (create VPR within item)
│   │   ├── edit.mjs               vpr edit (metadata)
│   │   ├── remove.mjs             vpr remove (dissolve VPR)
│   │   ├── generate.mjs           vpr generate (LLM description)
│   │   ├── send.mjs               vpr send (linearize + push)
│   │   ├── list.mjs               vpr list (JSON output)
│   │   ├── status.mjs             vpr status (human output)
│   │   ├── log.mjs                vpr log (jj graph)
│   │   ├── hold.mjs               vpr hold/unhold
│   │   └── init.mjs               vpr init
│   ├── tui/
│   │   ├── tui.mjs                main loop, mode dispatch
│   │   ├── render.mjs             draw the screen
│   │   ├── tree.mjs               build tree from state
│   │   ├── modes/
│   │   │   ├── normal.mjs         normal mode key handler
│   │   │   ├── interactive.mjs    interactive mode (squash/split/reword)
│   │   │   └── split.mjs          file split mode
│   │   └── editor.mjs             $EDITOR helpers
│   └── providers/
│       ├── base.mjs
│       ├── azure-devops.mjs
│       ├── github.mjs
│       └── none.mjs
└── test/
```

### Key module: `core/state.mjs`

Single function that reads jj graph + meta.json and returns unified state. Both CLI and TUI consume this. One source of truth.

```js
{
  items: [
    {
      name: 'ding-app',
      wi: 17065,
      wiTitle: 'Ding Convertor app',
      vprs: [
        {
          bookmark: 'vpr/ding-app/scaffold',
          prTitle: 'Scaffold',
          prPrompt: '...',
          prBody: null,
          commits: [ { changeId, subject, conflict } ],
          sent: false,
          conflict: false
        }
      ]
    }
  ],
  ungrouped: [ { changeId, subject } ],
  hold: [ { changeId, subject } ],
  conflicts: [ 'changeId1', 'changeId2' ],
  isLinear: true
}
```

## CLI Commands

```bash
# Items
vpr ticket new "Ding Convertor"     create item + work item + parallel branch
vpr ticket new 17065                attach to existing work item
vpr ticket list                     list all items
vpr ticket edit <name>              update item title/description
vpr ticket done <name>              mark item as done

# VPRs
vpr add "Scaffold"                  create VPR in current item
vpr add "Scaffold" --item ding-app  create VPR in specific item
vpr edit <vpr> --prompt "..."        write PR story
vpr edit <vpr> --title "..."        set PR title
vpr remove <vpr>                    dissolve VPR (commits ungrouped)
vpr list                            JSON: items → VPRs → commits + eventLog
vpr status                          human-readable overview
vpr log [N]                         jj graph with VPR annotations

# AI
vpr generate <vpr>                  generate PR description from story
vpr generate --all                  generate all empty descriptions

# Work
vpr hold <changeId>                 park a commit
vpr unhold <changeId>               release from hold

# Push
vpr send <vpr>                      send one VPR (checks + push + create PR)
vpr send --all                      send all (asks for order first)
vpr send --dry-run                  preview without pushing
```

## TUI

### Layout

Tree left, diff/metadata right. Split pane.

```
VPR  2 items, 5 vprs, 12 commits

▼ Ding Convertor (#17065)
    ✓ Scaffold              (sent, PR #4952)
    · Components
        ab12cd34 feat(ding): AudioPlayer
        ef56gh78 feat(ding): Uploader
    · Routing
      ! ij90kl12 feat(ding): wire up routes
▼ transit.sh (#17061)
    · Idempotent
        mn34op56 feat(scaffold): status audit
  Ungrouped (1)
    qr78st90 docs: spec
──────────────────────┬──────────────────────
                      │ diff / metadata / story
```

Status indicators:
- `✓` sent (pushed, PR created)
- `·` pending (not sent)
- `!` conflict
- `⏸` held

### Keys — normal mode

```
j/k         navigate
J/K         scroll right pane
v           toggle diff / file list
Enter       open in $EDITOR (context: item fields, VPR story, commit message)
n           new item (vpr ticket new)
a           add VPR (vpr add)
d           dissolve VPR
H           hold/unhold commit
i           interactive mode on a VPR
O           reorder push order in $EDITOR
E           edit ALL stories/descriptions in $EDITOR
P           send this VPR (push + create PR)
u           undo
:           jj command
q           quit
```

### Interactive mode (`i` on a VPR)

Opens `$EDITOR` with the commit list in `git rebase -i` style:

```
# Interactive rebase: Components (Ding Convertor)
# Commands: pick, squash, drop, reword
#
pick ab12cd34 feat(ding): AudioPlayer        (AudioPlayer.tsx +19)
pick ef56gh78 feat(ding): Uploader           (Uploader.tsx +111)
pick ij90kl12 feat(ding): RackUnitIcon       (RackUnitIcon.tsx +91)
```

Save and close → VPR executes the operations via jj.

### File split

`s` on a commit in the interactive editor adds a `split` command:

```
split ab12cd34 feat(ding): AudioPlayer       (AudioPlayer.tsx +19)
```

On save, VPR runs `JJ_EDITOR=true jj split -r <id>` for each split.

Or: a separate file-picker mode like v1 (`Space` to select files, `y`/`Enter` to split).

### E — bulk edit all metadata

Opens `$EDITOR` with all items/VPRs:

```
# ═══════════════════════════════════
# Ding Convertor app (#17065)
# ═══════════════════════════════════

## Scaffold
--- Prompt ---
Sets up the app shell with auth, vite, MSW, smoke test.

--- PR Description ---


## Components
--- Prompt ---
Ports AudioPlayer, Uploader, ConversionView.

--- PR Description ---


# ═══════════════════════════════════
# transit.sh (#17061)
# ═══════════════════════════════════

## Idempotent scaffold
--- Prompt ---

--- PR Description ---

```

On save:
- VPR parses sections back into meta.json
- If any `--- PR Description ---` is empty and story is filled: "Generate empty descriptions? (y/n)"
- If `y`: runs LLM, reopens vim with descriptions filled in

### O — reorder push order

Opens `$EDITOR`:

```
# Set push order — move lines to reorder
# Items sharing files are annotated
#
# [ding-app] ──────────────────────────
vpr/ding-app/scaffold          # Scaffold
vpr/ding-app/components        # Components  (scaffold_site.py)
vpr/ding-app/routing           # Routing
#
# [transit-sh] ────────────────────────
vpr/transit-sh/idempotent      # Idempotent  (scaffold_site.py)
```

Shared file annotations warn about potential conflicts. Order saved and used by `vpr send --all`.

### P — send

On a VPR header:

```
Scaffold (Ding Convertor)

✓ Story written
✗ Description empty (generate? y/n)
✓ 2 commits, no conflicts
  Target: main

Push and create PR? (y/n)
```

Steps through checks, then pushes.

## Claude Integration

### What Claude reads

`vpr list` returns JSON with items, VPRs, commits, event log. Claude reads this to understand state.

### What Claude writes

```bash
vpr ticket new "..."        create item
vpr add "..."               add VPR
vpr edit <vpr> --prompt "..."  write story
jj new -m "..."             make commits (normal jj)
vpr generate --all          generate descriptions
```

### Event log

Every action appends to `eventLog` in meta.json:

```json
{ "ts": "...", "actor": "claude", "action": "add", "item": "ding-app", "vpr": "scaffold" }
{ "ts": "...", "actor": "tui", "action": "squash", "changeId": "abc123" }
```

Claude checks the log to see what the human did in the TUI. The human sees what Claude did via the TUI refresh.

Capped at 100 entries. Actor is `claude`, `tui`, or `cli`.

### Skill file

Tells Claude:
- Read `vpr list` before making changes
- Check `eventLog` for recent human actions
- Use `vpr ticket new` for items, `vpr add` for VPRs
- Use jj directly for commits
- Write stories for every VPR
- Don't push without review — the human does `vpr send`

### vpr-send skill

Separate skill for the push ceremony:
1. Review each VPR's commits
2. Verify stories are written
3. Generate missing descriptions
4. Check for tests and docs
5. Run tests
6. Preview chain
7. Send one at a time

## Conflict Handling

- jj handles conflicts — VPR doesn't prevent them
- TUI shows `!` on conflicted commits (from `jj log -r 'conflicts()'`)
- `vpr send` blocks if conflicts exist
- That's it

## Send Flow

`vpr send <vpr>`:
1. Check story exists
2. Check no conflicts
3. If description empty, offer to generate
4. Determine target branch (previous VPR's branch, or main)
5. Linearize if needed (rebase onto target)
6. `jj git push --bookmark <vpr>`
7. Create PR via provider (title, body, target branch, work item link)
8. Record in `sent` section of meta.json
9. Assign TP index at this point (TP-1, TP-2, etc based on send order)

`vpr send --all`:
1. Open `$EDITOR` with VPR list to confirm order
2. Run send flow for each VPR in order
3. Each targets the previous

## Build Plan

Fresh rewrite on `v2` branch. Each module is a commit with tests.

1. `core/jj.mjs` + tests
2. `core/meta.mjs` + tests
3. `core/state.mjs` + tests
4. `commands/ticket.mjs` + tests
5. `commands/add.mjs` + tests
6. `commands/edit.mjs` + tests
7. `commands/list.mjs` + tests
8. `commands/status.mjs` + tests
9. `commands/log.mjs` + tests
10. `commands/generate.mjs` + tests
11. `commands/hold.mjs` + tests
12. `commands/remove.mjs` + tests
13. `commands/send.mjs` + tests
14. `commands/init.mjs` + tests
15. `tui/tree.mjs` + tests
16. `tui/render.mjs`
17. `tui/editor.mjs`
18. `tui/modes/normal.mjs`
19. `tui/modes/interactive.mjs`
20. `tui/modes/split.mjs`
21. `tui/tui.mjs` (main loop)
22. `bin/vpr.mjs`
23. Skill files update
24. README update
