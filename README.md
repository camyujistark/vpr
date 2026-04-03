# VPR — Virtual Pull Request Manager

Organize commits into virtual PR groups, refine the story, then push as chained git branches.

## Why

Maintaining real branch chains during development is fragile — amending cascades rebases, cherry-picks produce empty commits, moving changes between PRs means starting over. VPR keeps everything on one branch using jj bookmarks as PR boundaries. Real git branches are created at push time.

## Quick Start

```bash
cd /path/to/vpr && npm link   # install globally
cd your-project
vpr init                       # set up provider + prefix
```

## Workflow

```
vpr new "Title" "Desc"          # create ticket + local bookmark
code freely, commit as you go
vpr move <sha> --after <sha>    # organize commits
vpr edit tp-1 --pr-desc "..."   # write PR story
vpr send --dry-run              # preview the chain
vpr send                        # push branches + create PRs
```

## PR Story

Each VPR group has a **PR story** — your intent and context for the reviewer.

- **With Claude:** At push time, the AI combines the story + commits + files changed to craft a polished PR description. The story drives the narrative, the code provides the detail.
- **Without Claude:** The story is used as-is for the PR description.
- **In the TUI:** Edit via `J/K` to select the PR Story field, `e` to edit inline.
- **In the CLI:** `vpr edit <id> --pr-desc "your story"`

## CLI Commands

| Command | Alias | What it does |
|---------|-------|-------------|
| `vpr status` | `vpr s` | Show chain with commits + files |
| `vpr list` | `vpr l` | JSON output for AI parsing |
| `vpr new "title" "desc"` | `vpr n` | Create ticket + bookmark |
| `vpr edit <id> --flag "val"` | `vpr e` | Edit ticket/PR fields |
| `vpr move <sha> --after <sha>` | `vpr m` | Move commit |
| `vpr delete <id>` | `vpr d` | Delete commit or group |
| `vpr squash <sha>` | | Squash into parent |
| `vpr split <sha>` | | Split commit interactively |
| `vpr send --dry-run` | | Preview what would push |
| `vpr send` | | Push branches + create PRs |
| `vpr push [id]` | | Push bookmark as git branch |

`<id>` can be: bookmark name, project index (e.g. tp-91), or partial match.

## TUI

```bash
vpr                # open interactive TUI
```

Split-pane: groups on left, diff or PR metadata on right.

| Key | Action |
|-----|--------|
| `j/k` | Navigate |
| `J/K` | Select field / scroll diff |
| `e` / `Enter` | Edit selected field inline |
| `Esc` / `Ctrl+C` | Save edit / quit |
| `Space` | Pick/drop commit to reorder |
| `c` | Commit (jj commit) |
| `n` | New ticket |
| `d` | Delete commit or group |
| `s` | Squash into parent |
| `f` | Split commit |
| `u` | Undo (jj undo) |
| `S` | Sync ticket to provider |
| `b` | Set bookmark on commit |
| `:` | Run jj command |
| `q` | Quit |

## How It Works

- **jj bookmarks** define PR boundaries — each bookmark becomes a git branch at push time
- **`.vpr/meta.json`** stores ticket IDs, PR titles, PR stories — local only, gitignored
- **`.vpr/config.json`** stores provider settings (Azure DevOps, GitHub, etc.)
- Commits are freely reordered with `jj rebase` — bookmarks follow automatically
- `vpr send` pushes each bookmark as a git branch, creates chained PRs

## Providers

| Provider | Work Items | PRs | CLI Tool |
|----------|-----------|-----|----------|
| `azure-devops` | Azure Boards | `az repos pr` | `az` |
| `github` | GitHub Issues | `gh pr` | `gh` |
| `none` | Local IDs | Manual | — |

## Tests

```bash
npm test    # 99 tests
```

## License

MIT
