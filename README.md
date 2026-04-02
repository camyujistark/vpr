# VPR — Virtual Pull Request Manager

Group atomic commits into virtual PRs, refine the story, then render into real branch chains when ready to push.

## Problem

Maintaining real branch chains during development is fragile. Amending an early commit cascades rebases. Cherry-picks silently produce empty commits. Moving a change between PRs means rebasing the entire chain. One mistake can lose work.

## Solution

Work on **one branch**. Tag commits to virtual PR groups via git trailers. Rearrange freely. Render the branch chain once at push time.

```
One working branch           VPR groups              Real branches
─────────────────           ──────────              ─────────────
feat(media): ...      ─┐    TP-1: [2 commits]  ──► feat/123-typst
test(media): ...      ─┤    TP-2: [1 commit]   ──► feat/124-docker
refactor(docker): ... ─┘    TP-3: [3 commits]  ──► feat/125-ansible
```

## Quick Start

```bash
# Install globally
cd /path/to/vpr && npm link

# Initialize in your project
cd your-project
vpr init

# Open the TUI
vpr
```

## Init

`vpr init` creates a `.vpr/` directory (gitignored) with your config:

```
? Which provider?
  1) azure-devops
  2) github
  3) bitbucket
  4) gitlab
  5) none

? VPR prefix: TP
? Organization URL: https://dev.azure.com/YourOrg
? Project name: My Project
? Repository name: my-repo
```

Config is stored in `.vpr/config.json`. VPR metadata (titles, descriptions, work item IDs) in `.vpr/meta.json`.

## Commit Format

Conventional commits with a `VPR:` trailer in the body:

```
feat(media): replace texlive with typst

VPR: TP-92
```

The subject line stays clean. The trailer is metadata that VPR reads and manages.

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`, `style`, `perf`

## TUI

Split-pane layout — VPR groups on the left, diff or PR summary on the right.

### Keys (lazygit-style)

| Key | Action |
|-----|--------|
| `j/k` | Navigate list |
| `J/K` | Scroll diff pane |
| `PgUp/PgDn` | Page through diff |
| `Space` | Pick up / drop commit |
| `n` | New VPR group |
| `g` | Merge VPR into another |
| `r` | Rename VPR |
| `t` | Edit PR title |
| `d` | Edit PR description |
| `w` | Create/sync work item |
| `R` | Refresh from git |
| `s` | Save (rewrite trailers via rebase) |
| `Esc` | Cancel pick |
| `q` | Quit |

### Views

**On a VPR header** — right pane shows PR summary:
- Work item ID, title, state
- PR title and description drafts
- All commits with conventional commit types
- All files changed with +/- counts

**On a commit** — right pane shows the full diff

## Providers

VPR abstracts work item and PR creation behind providers:

| Provider | Work Items | PRs | CLI Tool |
|----------|-----------|-----|----------|
| `azure-devops` | Azure Boards | `az repos pr` | `az` |
| `github` | GitHub Issues | `gh pr` | `gh` |
| `bitbucket` | (planned) | (planned) | — |
| `gitlab` | (planned) | (planned) | — |
| `none` | Local IDs | Manual | — |

## Rules

- **Max 10 VPRs** — this is a buffer zone, not a permanent system
- **Ordering matters** — if VPR B touches a file that VPR A also touches, A must render before B
- **Ungrouped commits** — any commit without a `VPR:` trailer is flagged

## Workflow

```
code freely on one branch
         ↓
vpr              — view and organize VPR groups
         ↓
refine           — add docs, tests, reword, edit PR titles
         ↓
vpr render       — create real branch chain
         ↓
verify + push    — step through each PR
```

## Project Structure

```
vpr/
├── bin/vpr.mjs                 CLI entry point
├── src/
│   ├── config.mjs              Project config (.vpr/config.json)
│   ├── git.mjs                 Git helpers
│   ├── tui.mjs                 Interactive TUI
│   ├── providers/
│   │   ├── base.mjs            Provider interface
│   │   ├── azure-devops.mjs    Azure DevOps (az cli)
│   │   ├── github.mjs          GitHub (gh cli)
│   │   ├── none.mjs            No-op provider
│   │   └── index.mjs           Provider factory
│   └── commands/
│       └── init.mjs            vpr init command
├── test/
│   ├── config.test.mjs         Config + provider tests
│   └── git.test.mjs            Git helper + trailer tests
└── package.json
```

## License

MIT
