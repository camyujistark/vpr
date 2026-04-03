name: vpr
description: Use when managing virtual PR groups — creating tickets, editing PR metadata, moving commits between groups, viewing chain status

# VPR — Virtual PR Management

Manage virtual PR groups via the `vpr` CLI. Creates tickets/issues, organizes commits into PR groups using jj bookmarks, and prepares PR metadata for pushing.

## Commands

Run these with the Bash tool. JSON output where relevant.

### Create ticket
```bash
vpr new "Title" "Description"
```

### Edit fields
```bash
vpr edit <id> --title "New title"         # also renames branch
vpr edit <id> --desc "Description"
vpr edit <id> --pr-title "GH-1: Title"
vpr edit <id> --pr-desc "## Summary\n..."
```

### Move commits
```bash
vpr move <changeId> --after <targetId>
vpr move <changeId> --before <targetId>
```

### Squash and split
```bash
vpr squash <changeId>                     # squash into parent
vpr split <changeId>                      # split interactively
```

Use `JJ_EDITOR=true` when running `jj split` directly to prevent it hanging:
```bash
JJ_EDITOR=true jj split -r <changeId> path/to/file
```

### Delete
```bash
vpr delete <changeId>     # single commit
vpr delete <id>           # entire group + commits
```

### View
```bash
vpr list                  # JSON array of groups with commits, targets, PR info
vpr status                # human-readable chain summary
```

### Push
```bash
vpr push                  # all bookmarks
vpr push <id>             # specific bookmark
```

### Send (push + create PRs)
```bash
vpr send                  # all groups, interactive
vpr send <id>             # specific group
vpr send --dry-run        # preview only
```

`<id>` can be: bookmark name, project index (e.g. `GH-1`), or partial match.

## Interactive TUI

For hands-on organization:

```bash
vpr
```

Keys: `j/k` nav, `J/K` field/scroll, `Space` move commits, `Enter` edit field, `c` commit, `n` new ticket, `d` delete, `s` squash, `f` split, `u` undo, `:` jj command, `S` sync to provider, `q` quit.

## Important

- **Always use the Bash tool directly.** Never delegate to an Agent.
- **Use `vpr list` for JSON chain state** before making changes.
- **Use `vpr status` for human-readable output** to show the user.
- **When showing `vpr status` output**, strip ANSI codes: `vpr status | sed 's/\x1b\[[0-9;]*m//g'`
