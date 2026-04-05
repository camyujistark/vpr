# VPR — Virtual Pull Request Manager

Gain control over what goes up to git — especially with AI-assisted coding.

AI agents write code fast. Without control, you push up a mess: giant PRs, no narrative, reviewers can't follow. VPR lets you pause, organize work into stories, and push clean stacked PRs when you're ready.

## The Problem

You've been coding — maybe with Claude, maybe solo — and you have 30 commits locally. Your team wants small, reviewable PRs that tell a story. You need to:

1. Group commits into logical PRs
2. Write a narrative for each one
3. Push them as a chain where each PR targets the previous
4. Link them to work items

That's what VPR does.

## Concepts

### Stories and Chapters

- **Story** = a work item / ticket. The big picture: "Ding Convertor app", "transit.sh improvements"
- **Chapters** = PRs within a story. Each chapter is a small, reviewable narrative: "Scaffold", "Components", "Routing"
- **Commits** = the raw work inside each chapter

```
Story: Ding Convertor app (#17065)
├── Chapter 1: Scaffold           → PR targeting main
├── Chapter 2: Audio components   → PR targeting chapter 1
├── Chapter 3: Upload flow        → PR targeting chapter 2
└── Chapter 4: E2E tests          → PR targeting chapter 3
```

### Parallel Stories, Linear Chapters

Stories are **parallel branches** off trunk — they don't interfere with each other. Chapters within a story are **linear** — each builds on the previous.

```
trunk
├── story: transit-sh (parallel)
│   ├── chapter: scaffold
│   └── chapter: idempotent
├── story: ding-app (parallel)
│   ├── chapter: scaffold
│   ├── chapter: components
│   └── chapter: routing
└── story: shared-ui (parallel)
    ├── chapter: StepFlow
    └── chapter: MediaUploader
```

At push time, VPR linearizes stories into a chain and pushes as stacked PRs.

### Source of Truth

**jj owns the graph** — commits, bookmarks, parent-child relationships, conflicts. VPR never fights jj.

**meta.json owns the metadata** — story titles, chapter narratives, PR descriptions, work item IDs, push order.

They connect through **bookmark names** — that's the only join key. No indexes to drift, no graph mirroring, no renumbering.

## Built on jj

[jj (Jujutsu)](https://martinvonz.github.io/jj/) does the heavy lifting:

- **Parallel branches** — stories are siblings, naturally isolated
- **Rebase** — move commits anywhere, jj auto-rebases descendants
- **Bookmarks** — lightweight pointers that follow their commits
- **Conflicts as data** — don't block operations, resolve when ready
- **Colocated mode** — sits alongside git, `jj git push` pushes real git branches

VPR reads jj's graph, attaches metadata, and handles the push ceremony.

## Workflow

### 1. Plan — create stories

```bash
vpr new "Ding Convertor app"        # creates work item + parallel branch
vpr new "transit.sh improvements"   # another parallel story
```

### 2. Build — make commits freely

```bash
jj new -m "feat(ding): scaffold app"
jj new -m "feat(ding): add AudioPlayer"
# AI agents can commit too — it all stays local
```

### 3. Organize — mark chapter boundaries

```bash
vpr chapter "Scaffold"              # mark where this chapter ends
vpr chapter "Components"            # next chapter starts here
```

Or use the TUI to visually slice commits into chapters.

### 4. Review — write the narrative

Each chapter gets a **story** — your intent and context for the reviewer.

```bash
vpr edit <chapter> --story "Scaffolds the Ding app with auth, vite config, and smoke test"
```

Or in the TUI: `s` to edit story, `S` to generate a PR description from the story via LLM.

### 5. Move around — jj handles it

```bash
jj rebase -r <commit> -A <target>  # move a commit between chapters
jj squash                          # squash into parent
jj split                           # split a commit
```

VPR doesn't interfere. jj moves commits, VPR tracks the metadata.

### 6. Send — push when ready

```bash
vpr send                           # linearize + push + create PRs
```

VPR:
1. Shows you the push order (stories → chapters)
2. Linearizes parallel stories into a chain
3. Pushes each bookmark as a git branch
4. Creates PRs — each targeting the previous
5. Links work items
6. Reports any conflicts

Nothing goes up until you say so.

## TUI

```bash
vpr                                # open TUI
```

Split-pane: stories/chapters on the left, diff/metadata on the right. Three modes: normal → interactive → file split. `Esc` goes back one level.

### Normal mode

| Key | Context | Action |
|-----|---------|--------|
| `j/k` | All | Navigate |
| `J/K` | All | Scroll right pane |
| `v` | Commit | Toggle diff / file list view |
| `n` | All | New story (creates work item + parallel branch) |
| `t` | Chapter | Edit PR title |
| `s` | Chapter | Edit PR story |
| `E` | Chapter | Edit all fields in $EDITOR |
| `S` | Chapter | Generate PR description from story via LLM |
| `O` | All | Set push order in $EDITOR |
| `d` | Chapter | Dissolve — remove chapter, commits become ungrouped |
| `H` | Commit | Toggle hold (park a commit) |
| `i` | Chapter | Enter interactive mode |
| `u` | All | Undo |
| `:` | All | Run arbitrary jj command |
| `q` | All | Quit |

### Interactive mode (`i` on a chapter)

Zoom into a chapter to refine before pushing.

| Key | Action |
|-----|--------|
| `Space` | Toggle select on commit |
| `s` | Split (no selection) or squash (with selection) |
| `d` | Drop selected commits |
| `r` | Reword commit message |
| `v` | Toggle diff / file list |
| `Esc` | Back to normal |

### File split mode (`s` on a commit in interactive)

Pick files to split out of a commit into a new commit.

| Key | Action |
|-----|--------|
| `Space` | Toggle select on file |
| `y`/`Enter` | Execute split |
| `Esc` | Back to interactive |

## CLI

For AI agents and scripting — JSON output where relevant.

```bash
# Stories
vpr new "title" ["description"]       Create story + work item + parallel branch
vpr list                              JSON: stories, chapters, commits
vpr status                            Human-readable overview
vpr log [N]                           jj graph with VPR annotations

# Chapters
vpr chapter "title"                   Mark a chapter boundary (bookmark)
vpr edit <id> --title "val"           Edit chapter title
vpr edit <id> --story "val"           Edit chapter story
vpr generate <id>                     Generate PR description from story via LLM

# Pushing
vpr send                              Linearize + push + create PRs
vpr send --dry-run                    Preview without pushing
vpr push [bookmark]                   Push bookmarks as git branches

# Utilities
vpr hold <changeId>                   Park a commit
vpr unhold <changeId>                 Release from hold
vpr sort                              Analyze dependencies, suggest ordering
vpr clean                             Remove stale bookmarks
```

`<id>` can be: bookmark name, story name, or partial match.

## PR Story + Generation

Each chapter has a **story** — what it does and why. And optionally a **generated description** — a formatted PR body from the story + commits.

- **Write the story:** TUI `s`, or `vpr edit <id> --story "..."`
- **Generate description:** TUI `S`, or `vpr generate <id>`
- **At send time:** generated description is used as the PR body (falls back to the story)

### LLM Configuration

```json
{
  "generateCmd": "claude -p"
}
```

Receives prompt on stdin, outputs PR description on stdout. Defaults to `claude -p` if installed. Any LLM works.

## Data Model

### meta.json

```json
{
  "stories": {
    "ding-app": {
      "wi": 17065,
      "wiTitle": "Ding Convertor app",
      "chapters": {
        "feat/ding-scaffold": { "prTitle": "Scaffold", "prStory": "...", "prBody": "..." },
        "feat/ding-components": { "prTitle": "Components", "prStory": "..." }
      }
    }
  },
  "pushOrder": ["shared-ui", "transit-sh", "ding-app"],
  "hold": ["vonutytoluqs"],
  "done": {}
}
```

- **jj owns the graph** — commits, bookmarks, topology
- **meta.json owns the metadata** — stories, chapter narratives, push order
- **Bookmark names are the join key** — no indexes, no mirroring

## Providers

| Provider | Tickets | PRs | CLI |
|----------|---------|-----|-----|
| GitHub | Issues | Pull Requests | `gh` |
| Azure DevOps | Work Items | Pull Requests | `az` |
| None | Local IDs | — | — |

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [jj (Jujutsu)](https://martinvonz.github.io/jj/) — colocated with git
- Provider CLI (`gh` or `az`) — optional

## Install

```bash
git clone https://github.com/yourorg/vpr.git
cd vpr
npm link
```

Zero dependencies — just Node.js built-ins.

## AI Agent Integration

VPR has two interfaces:

**CLI** — for AI agents (Claude Code, etc.). JSON in, JSON out. The agent reads `vpr list` to understand state, uses `vpr chapter` and `vpr edit` to organize, and the human reviews in the TUI.

**TUI** — for humans. Visual overview, move things around, edit stories inline, preview before pushing.

Both read/write the same meta.json + jj bookmarks. The AI doesn't need the TUI. The human doesn't need the CLI. Both see the same state.

### Skill files

```bash
cp vpr/skills/*.md ~/.claude/skills/vpr/
```

The skills teach AI agents the VPR workflow: create stories, organize chapters, write narratives, don't push without review.

## Project Structure

```
vpr/
├── bin/vpr.mjs              — CLI entry point
├── src/
│   ├── commands/
│   │   ├── cli.mjs          — All CLI commands
│   │   └── init.mjs         — Interactive setup wizard
│   ├── providers/
│   │   ├── base.mjs         — Provider interface
│   │   ├── azure-devops.mjs — Azure DevOps (az CLI)
│   │   ├── github.mjs       — GitHub (gh CLI)
│   │   └── none.mjs         — Local no-op
│   ├── config.mjs           — .vpr/ config + meta management
│   ├── entries.mjs          — Shared entry loading + grouping
│   ├── git.mjs              — jj/git helpers
│   └── tui.mjs              — Terminal UI
└── test/                    — Node test runner specs
```

## Tests

```bash
npm test    # Node test runner, zero dependencies
```

## License

MIT
