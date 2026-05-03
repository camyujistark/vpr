import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Drives VPR slices to completion via TDD inside a docker sandbox.
//
// Single item:    VPR_ITEM=my-item npx tsx .sandcastle/main.ts
// Multiple items: VPR_ITEMS=item-a,item-b,item-c npx tsx .sandcastle/main.ts
// CLI args:       npx tsx .sandcastle/main.ts item-a item-b
//
// When more than one item is passed, each runs concurrently in its own
// container on its own branch (merge-to-head merges each agent's commits back
// to the host branch on completion).
//
// CANONICAL TEMPLATE — lives in vpr/templates/sandcastle-main.ts. Consuming
// repos symlink their .sandcastle/main.ts at this file so updates land in one
// place. .sandcastle/ is gitignored in most repos; the symlink target lives
// outside the gitignore so the script survives `git clean -fdx` style purges.

const cliItems = process.argv.slice(2).filter(Boolean);
const envItems = (process.env.VPR_ITEMS ?? process.env.VPR_ITEM ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const items = cliItems.length > 0 ? cliItems : envItems;

if (items.length === 0) {
  console.error("Usage: npx tsx .sandcastle/main.ts <item> [<item> ...]");
  console.error("Or: VPR_ITEM=<item> | VPR_ITEMS=<item-a>,<item-b> npx tsx .sandcastle/main.ts");
  process.exit(1);
}

// Write the active item name to a sentinel file the prompt can `cat` —
// avoids relying on $VPR_ITEM env-var expansion inside sandcastle's shell-
// expression preprocessor (which does not reliably inherit run({env})).
const writeSentinel = (VPR_ITEM: string) => {
  const dir = join(process.cwd(), ".vpr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-item.txt"), VPR_ITEM);
};

// Pre-flight: refuse to run if working tree is dirty. Sandcastle commits in
// a worktree then merges back to host HEAD. If the host has uncommitted edits
// to the same files ralph touches, merge-back fails and the temp branch sits
// preserved while ralph progress is lost from the chain. Force-clean state
// before the run avoids a long iteration cycle that ends in a merge conflict.
const checkGitClean = () => {
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (status.trim()) {
      console.error("✗ Refusing to start ralph: working tree has uncommitted changes.");
      console.error("  Ralph commits to a sandcastle branch then merges back to HEAD.");
      console.error("  If your local edits touch the same files, the merge will fail.");
      console.error("  Commit, stash, or discard first:");
      console.error("    git stash push -u   # then `git stash pop` after ralph completes");
      console.error("    git commit -am '<msg>'");
      console.error("");
      console.error("Uncommitted files:");
      console.error(status);
      process.exit(1);
    }
  } catch {
    /* not a git repo — let sandcastle proceed and fail with a clearer error if it must */
  }
};

// Snapshot git HEAD + branch refs before the run. Pairs with the jj snapshot
// for recovery: if ralph leaves the chain in an unexpected state, both refs
// are captured so the user can diff or roll back.
const writeGitSnapshot = () => {
  try {
    const head = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    const branches = execSync("git branch --format='%(refname:short) %(objectname)'", {
      encoding: "utf-8",
    });
    const dir = join(process.cwd(), ".vpr");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "git-pre-snapshot.txt"), `HEAD ${head}\n${branches}`);
    console.log(`→ git snapshot: HEAD=${head.slice(0, 8)} (rollback: git reset --hard ${head.slice(0, 8)})`);
  } catch {
    /* not git — skip */
  }
};

// Capture jj op-log head before the run starts. Sandcastle's merge-to-head
// strategy creates git refs the host jj must import on completion; if a
// divergent change-id collides, `jj abandon` can cascade across the chain
// (this happened in earlier runs). One snapshot per `npx tsx .sandcastle/main.ts`
// invocation gives the user a single `vpr recover` to undo the entire run.
// Skips silently if jj isn't available or this isn't a jj-colocated repo.
const writeJjSnapshot = () => {
  try {
    const opId = execSync(`jj op log -T 'self.id().short()' --no-graph -n 1`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!opId) return;
    const dir = join(process.cwd(), ".vpr");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ralph-snapshot.txt"), opId);
    console.log(`→ jj op snapshot: ${opId} (recover with: vpr recover)`);
  } catch {
    /* not jj-colocated — skip */
  }
};

// After a successful run, advance slice bookmarks from Ralph-Slice trailers.
// Requires jj; silently skips if jj is absent or sync finds nothing to do.
const syncAfterRun = (VPR_ITEM: string) => {
  try {
    execSync(`node bin/vpr.mjs sync ${VPR_ITEM}`, { stdio: "inherit" });
  } catch {
    console.error(`⚠ vpr sync ${VPR_ITEM} failed (non-fatal) — run manually if needed`);
  }
};

const runOne = async (VPR_ITEM: string) => {
  writeSentinel(VPR_ITEM);
  await run({
    // Prefix in log output. Distinguishes parallel agents.
    name: `ralph-${VPR_ITEM}`,

    // Forward VPR_ITEM into the sandbox so prompt.md shell expressions resolve it.
    env: { VPR_ITEM },

    // Sandbox provider — Docker. Mount host ~/.claude into the agent's home
    // so Claude Code is already logged in inside the container.
    sandbox: docker({
      mounts: [{ hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" }],
    }),

    // Agent provider. claude-sonnet-4-6 = balance (default).
    // Swap to claude-haiku-4-5-20251001 for speed, claude-opus-4-7 for
    // cross-cutting refactors / unfamiliar-codebase exploration.
    agent: claudeCode("claude-sonnet-4-6"),

    // Prompt file. Shell expressions inside (`!`...``) evaluate inside the
    // sandbox at the start of each iteration, so the agent always sees fresh
    // .vpr/meta.json + progress + test state.
    promptFile: "./.sandcastle/prompt.md",

    // Iterations per run. Each iteration handles one acceptance criterion
    // (per prompt.md constraints). Sized for multi-slice items where each
    // slice has 3-5 criteria.
    maxIterations: 30,

    // merge-to-head: each agent works on a temp branch, commits get merged
    // back to host HEAD on completion. Required for parallel — keeps branches
    // isolated until merge.
    branchStrategy: { type: "merge-to-head" },

    // Copy host node_modules into worktree to avoid full reinstall every iter.
    // onSandboxReady npm install handles platform-specific binaries.
    // .vpr/ is gitignored so wouldn't enter the worktree by default — copy it
    // explicitly so prompt.md's jq expressions can read meta.json.
    copyToWorktree: ["node_modules", ".vpr"],

    hooks: {
      sandbox: {
        // Flatten the .vpr/.vpr nesting that sandcastle's copyToWorktree
        // produces when the worktree already has a .vpr/ dir (e.g. when
        // the host repo has any .vpr/* files git-tracked).
        onSandboxReady: [
          { command: "if [ -d .vpr/.vpr ]; then mv .vpr/.vpr/* .vpr/ && rmdir .vpr/.vpr; fi" },
          { command: "npm install" },
        ],
      },
    },
  });
  syncAfterRun(VPR_ITEM);
};

checkGitClean();
writeGitSnapshot();
writeJjSnapshot();

if (items.length === 1) {
  await runOne(items[0]);
} else {
  console.log(`→ Running ${items.length} agents in parallel: ${items.join(", ")}`);
  const results = await Promise.allSettled(items.map(runOne));
  const failures = results.filter(r => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${items.length} agents failed`);
    failures.forEach((f, i) => console.error(`  ${items[i]}: ${(f as PromiseRejectedResult).reason}`));
    process.exit(1);
  }
  console.log(`✓ ${items.length}/${items.length} agents completed`);
}
