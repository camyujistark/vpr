# VPR — Virtual Pull Request Manager

Group commits into virtual PRs, organize them into a chain, then push as real PRs to your provider.

VPR sits on top of [jj (Jujutsu)](https://martinvonz.github.io/jj/) and uses bookmarks as PR boundaries. You work on a single branch, organize commits into groups with the TUI, and VPR renders them as chained branches and PRs at push time.

## Why

Stacked PRs are great for review but painful to maintain. Real branches cascade-rebase, cherry-picks lose commits, and the bookkeeping is brutal. VPR treats PRs as a view layer — you work linearly, and it handles the branch/PR plumbing.

## Built on jj

VPR is a thin layer on top of [jj (Jujutsu)](https://martinvonz.github.io/jj/), a modern VCS that replaces git's index-based workflow with first-class rebase, conflict-free rewrites, and immutable change IDs.

jj does the heavy lifting:

- **Rebase** — reorder commits and jj auto-rebases all descendants, no conflicts
- **Bookmarks** — lightweight pointers that follow their commits through rebases and describes
- **Describe** — rewrite any commit message instantly, no interactive rebase needed
- **Colocated mode** — jj sits alongside git, so `jj git push` pushes real git branches

VPR reads jj's commit graph, lets you group commits under bookmarks via a TUI, and translates that topology into chained PRs at push time. Every mutation (`vpr move`, `vpr squash`, `vpr split`, commit reorder in the TUI) is a jj operation under the hood — undoable with `jj undo`.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [jj (Jujutsu)](https://martinvonz.github.io/jj/) — colocated with git (`jj git init --colocate`)
- Provider CLI (pick one):
  - **GitHub**: [`gh`](https://cli.github.com/) authenticated via `gh auth login`
  - **Azure DevOps**: [`az`](https://learn.microsoft.com/en-us/cli/azure/) authenticated via `az login`
  - **None**: no CLI needed, local-only mode

## Install

```bash
git clone https://github.com/yourorg/vpr.git
cd vpr
npm link
```

Zero dependencies — just Node.js built-ins.

## Setup

Run `vpr init` in any git+jj repo:

```
$ cd my-project
$ jj git init --colocate      # if not already a jj repo
$ vpr init

  VPR Init — Configure virtual PR management for this project

Which provider?
  1) azure-devops
  2) github
  3) none
> 2
VPR prefix (e.g. TP, FE, BE) [GH]: MY
Repository (owner/repo) [yourname/my-project]: 

Initialized VPR with github provider (prefix: MY)
```

Creates `.vpr/config.json` (auto-added to `.gitignore`). The prefix names your PRs sequentially: `MY-1`, `MY-2`, etc.

## Workflow

```
1. Make commits         jj commit -m "add auth middleware"
2. Open TUI             vpr
3. Create groups        n (creates ticket + bookmark per group)
4. Move commits         Space to pick, Space to drop
5. Write PR stories     Enter on the PR Story field
6. Send                 vpr send (pushes branches, creates chained PRs)
```

Each group becomes a git branch. PR 2 targets PR 1's branch, PR 3 targets PR 2's. Reviewers see only the diff for each slice.

## TUI

```bash
vpr           # open interactive mode
```

Split-pane: groups on the left, diff/metadata on the right.

| Key | Action |
|-----|--------|
| `j/k` | Navigate commits and groups |
| `J/K` | Scroll fields or diff |
| `Enter` | Edit field inline |
| `Space` | Pick/drop commit to reorder |
| `n` | New group (creates ticket + bookmark) |
| `d` | Delete commit or group |
| `c` | Create new commit |
| `s` | Squash commit into parent |
| `f` | Split commit |
| `u` | Undo (`jj undo`) |
| `S` | Sync ticket to provider |
| `b` | Set bookmark on commit |
| `:` | Run arbitrary jj command |
| `q` | Quit |

Fields per group: **Ticket Title**, **Ticket Description**, **PR Title**, **PR Story**.

## CLI

For scripting and AI agents — all output is JSON where relevant.

```bash
vpr new "Add auth" "OAuth2 login"       # Create ticket + bookmark
vpr edit MY-1 --pr-title "MY-1: Auth"   # Set PR title
vpr edit MY-1 --pr-desc "Adds OAuth2"   # Set PR story
vpr move <sha> --after <sha>            # Reorder commits
vpr squash <sha>                        # Squash into parent
vpr split <sha>                         # Split commit interactively
vpr delete <sha>                        # Abandon a commit
vpr delete MY-1                         # Delete group + all commits
vpr list                                # JSON: all groups with commits + files
vpr status                              # Colored chain summary
vpr push                                # Push all bookmarks as git branches
vpr push MY-1                           # Push one bookmark
vpr send                                # Push + create PRs (interactive)
vpr send MY-1                           # Send one PR
vpr send --dry-run                      # Preview without pushing
vpr clean                               # Move stale bookmarks (no commits) to done
```

**Aliases:** `s` = status, `l` = list, `n` = new, `e` = edit, `m` = move, `d` = delete

`<id>` can be: bookmark name, prefix index (e.g. `MY-1`), or partial match.

## PR Story

Each group has a **PR story** — your intent and context for the reviewer.

- **With an AI assistant:** at push time, the AI combines the story + commits + diff to write a polished PR description
- **Without AI:** the story is used as-is for the PR body
- **TUI:** select the PR Story field, press Enter to edit
- **CLI:** `vpr edit <id> --pr-desc "your story"`

## Providers

| Provider | Tickets | PRs | CLI |
|----------|---------|-----|-----|
| GitHub | Issues | Pull Requests | `gh` |
| Azure DevOps | Work Items | Pull Requests | `az` |
| None | Local IDs | — | — |

### GitHub

```json
{
  "provider": "github",
  "prefix": "GH",
  "repo": "owner/repo"
}
```

Issues are created per group. PRs link via `Closes #<issue>`.

### Azure DevOps

```json
{
  "provider": "azure-devops",
  "prefix": "TP",
  "org": "https://dev.azure.com/YourOrg",
  "project": "YourProject",
  "repo": "your-repo",
  "wiType": "Task"
}
```

### None (local only)

```json
{
  "provider": "none",
  "prefix": "VPR"
}
```

No remote calls. Organize commits locally, push branches manually.

## How it works

jj bookmarks mark the tip of each commit group:

```
main
 └── commit A  ─┐
     commit B   ├── feat/123-auth       (MY-1)
     commit C  ─┘
      └── commit D  ─┐
          commit E   ├── feat/456-dash   (MY-2)
          commit F  ─┘
```

`vpr send`:

1. **Validates** — each group's diff only contains its own commits (catches ordering bugs)
2. **Pushes** each bookmark as a git branch
3. **Creates PRs** — each targeting the previous branch
4. **Closes tickets** — marks issues/work items as done
5. **Archives** — moves sent bookmarks from `bookmarks` to `done` in meta.json

jj handles rebase mechanics. Reorder commits and jj auto-rebases descendants. Bookmarks follow their commits. VPR reads the topology.

## Chain validation

Before sending, VPR checks that no commits from other groups leaked into a PR's diff. If the commit order doesn't match the group order:

```
⚠ Chain order mismatch — bookmarks contain commits from other groups:

  MY-2: contains commits from MY-3

Reorder commits so each group is contiguous before sending.
```

Fix with the TUI (Space to move) or CLI (`vpr move`).

## Project structure

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
│   ├── git.mjs              — jj/git helpers
│   └── tui.mjs              — Terminal UI
└── test/                    — Node test runner specs
```

## Tests

```bash
npm test    # 99 tests, zero dependencies
```

Uses Node's built-in test runner. Tests create temp git+jj repos.

## AI Agent Skills

VPR ships with skill files for AI coding assistants (Claude Code, etc.) in `skills/`:

- **`skills/vpr.md`** — managing groups, editing metadata, moving commits
- **`skills/vpr-send.md`** — the full push workflow: review chain, write PR stories, quality gate, push step by step

To use with Claude Code, copy or symlink into your skills directory:

```bash
# Claude Code project skills
cp vpr/skills/*.md ~/.claude/skills/vpr/

# Or symlink
ln -s /path/to/vpr/skills ~/.claude/skills/vpr
```

The skills teach the AI the full VPR workflow — creating tickets, organizing commits in the TUI, writing PR descriptions from stories + diffs, and pushing chained PRs one at a time.

## Adding a provider

1. Create `src/providers/your-provider.mjs` extending `BaseProvider`
2. Implement: `createWorkItem`, `getWorkItem`, `updateWorkItem`, `createPR`, `getLatestPRIndex`
3. Register in `src/providers/index.mjs`
4. Add config template to `PROVIDERS` in `src/config.mjs`
5. Add init prompts in `src/commands/init.mjs`

## License

MIT
