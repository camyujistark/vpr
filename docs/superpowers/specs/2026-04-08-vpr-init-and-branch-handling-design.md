# VPR Init + Branch Handling

## Problem

1. Setting up VPR in a new project requires multiple manual steps: jj init, creating `.vpr/` files, configuring exclusions. Easy to miss steps (as we discovered — jj wiping `.vpr/`, wrong provider, lock files from missing jj).

2. VPR defaults to `main` in multiple places (getBase, getChainTop, send targetBranch). When working off a feature branch, commits don't appear in the TUI and sends target the wrong branch.

## Feature 1: `vpr init`

### Behavior

One idempotent command to go from a bare git repo to a VPR-ready project. Skips any step where the artifact already exists.

### Steps

1. **jj colocate** — if `.jj/` does not exist, run `jj git init --colocate`
2. **Create `.vpr/config.json`** — from CLI flags, defaulting to `none` provider
3. **Create `.vpr/meta.json`** — empty structure: `{ items: {}, hold: [], sent: {}, eventLog: [] }`
4. **Git exclude** — append `.vpr/` and `.jj/` to `.git/info/exclude` (only lines not already present)
5. **jj exclude** — set `snapshot.auto-track` to `glob:"**" ~ glob:".vpr/**"` and untrack any already-tracked `.vpr/` files
6. **Print summary** — what was created/skipped

### CLI

```
vpr init                                    # none provider
vpr init --provider azure-devops \
  --org https://dev.azure.com/foo \
  --project "My Project" \
  --repo my-repo \
  --wiType Task
```

### Flag defaults

| Flag | Default |
|------|---------|
| `--provider` | `none` |
| `--org` | (required for azure-devops/github) |
| `--project` | (required for azure-devops) |
| `--repo` | derived from git remote or directory name |
| `--wiType` | `Task` |

### Files changed

- `src/commands/init.mjs` — implement init logic
- `bin/vpr.mjs` — pass CLI flags through to init (dispatch already exists)

## Feature 2: Stop defaulting to main

### Root cause

- `getBase()` used `ancestors(@, 1)` which only checks the immediate parent for remote bookmarks. Fixed to `ancestors(@)`.
- `getChainTop()` in base provider returns hardcoded `'main'`.
- `send()` falls back to `'main'` for targetBranch.

### Solution: `getBaseBranch()`

New function in `src/core/jj.mjs` that returns the **bookmark name** of the nearest remote ancestor commit.

```
jj log -r "ancestors(@) & remote_bookmarks()"
  --no-graph --template "bookmarks" -n 1
```

Strips `@origin` suffix. Returns local bookmark name (e.g. `feat/16956-script-trbo-backfill-data`). Falls back to `main` only when there are genuinely no remote bookmark ancestors.

### Integration points

| Location | Current | After |
|----------|---------|-------|
| `src/core/jj.mjs` | `getBase()` returns commit ID only | Add `getBaseBranch()` returning bookmark name |
| `src/providers/base.mjs` `getChainTop()` | Returns `'main'` | Returns `getBaseBranch() ?? 'main'` |
| `src/providers/azure-devops.mjs` `getChainTop()` | Falls back to `'main'` | Falls back to `getBaseBranch() ?? 'main'` |
| `src/commands/send.mjs` line 103 | `targetBranch ?? 'main'` | `targetBranch ?? getBaseBranch() ?? 'main'` |

### Files changed

- `src/core/jj.mjs` — add `getBaseBranch()`, keep existing `getBase()` fix
- `src/providers/base.mjs` — update `getChainTop()` default
- `src/providers/azure-devops.mjs` — update `getChainTop()` fallback
- `src/commands/send.mjs` — update targetBranch fallback

## Edge cases

- **No remote bookmarks at all** — `getBaseBranch()` returns null, everything falls back to `main`. Same behavior as today.
- **`.vpr/` already exists during init** — skip config/meta creation, still ensure exclusions are set.
- **jj already initialized** — skip `jj git init`, proceed with `.vpr/` setup.
- **Re-running init** — fully idempotent, safe to run multiple times.
- **Branch switching with jj** — `.vpr/` excluded from snapshot tracking so jj never touches it during checkout.
