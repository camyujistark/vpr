name: vpr-send
description: Use when pushing PRs from a VPR-managed project. Reviews chain, runs quality gate, pushes bookmarks, creates PRs step by step.

# VPR Send — Push PRs

Push VPR groups as chained PRs. Tickets, branches, and PR metadata are already prepared via `vpr` — this skill handles review, quality gate, push, and PR creation.

## Moving files between PRs

When the user asks to move a file to a different PR, use `jj split` to extract the file from its current commit, then `vpr move` the extracted commit into the target group. Never move a whole commit just for one file.

```bash
JJ_EDITOR=true jj split -r <changeId> path/to/file
vpr move <newChangeId> --after <targetId>
```

## Phase 1 — Review Chain

Show the chain to the user:

```bash
vpr status | sed 's/\x1b\[[0-9;]*m//g'
```

Get JSON for programmatic use:

```bash
vpr list
```

Present each group: index, ticket ID, branch, target, PR title, commit count.

Ask: "Does this chain look right? Any changes before pushing?"

## Phase 2 — PR Stories

Step through each PR. For any missing a description:

1. **Ask the user:** "What's the story for this PR?"
2. Wait for their answer
3. **Show the proposed description** before saving
4. Save: `vpr edit <id> --pr-desc "..."`

The PR story is the user's intent. At push time, combine the story + commits + files to craft the final PR description. The story drives the narrative, the code provides the detail.

**One PR at a time.** Show, ask, confirm, save, next. NEVER batch.

## Phase 3 — Quality Gate

Run all checks before pushing:

```bash
npm test              # unit tests
npm run lint          # linting (0 errors, warnings OK)
npx tsc --noEmit      # type check
```

Fix any failures before proceeding. Optionally ask about E2E tests.

## Phase 4 — Push (step by step)

For EACH group from `vpr list`, in order:

1. **Show PR details** — index, ticket, branch, target, title, body, commits + files

2. **Wait for user approval**

3. **Push the bookmark:**
   ```bash
   vpr push <id>
   ```

4. **Create the PR** via the provider. Use `vpr send <id>` or create manually:

   **GitHub:**
   ```bash
   gh pr create --repo owner/repo \
     --head <bookmark> --base <target> \
     --title "<prTitle>" --body "<prDesc>"
   ```

   **Azure DevOps:**
   ```bash
   az repos pr create --repository <repo> \
     --source-branch <bookmark> --target-branch <target> \
     --title "<prTitle>" --description "<prDesc>" \
     --work-items <wiId> \
     --project "<project>" --organization "<org>"
   ```

5. **Close the ticket** — mark issue/work item as done

6. **Next group**

**NEVER batch-push.** Step through each one even if there are many.

## Displaying PRs

Format each PR for user review:

```
### PR N: GH-X — Title

> **Branch:** `feat/xxx-slug` → `feat/xxx-target`
> **Title:** GH-X: Title
> **Ticket:** #XXX
> **Body:** description or *(empty)*

**Commits:**
- `changeId` commit subject
  - **A** `path/to/new-file`
  - **M** `path/to/modified-file`
```

## Important

- Use `vpr list` JSON for all metadata — don't read `.vpr/meta.json` directly
- Each group's `target` field is the branch to target the PR against
- Each group's `bookmark` is the source branch name
- `prTitle` → PR title, `prDesc` → PR story (combine with diff for final description)
- Chain validation runs automatically on `vpr send` — blocks if commits are misordered
