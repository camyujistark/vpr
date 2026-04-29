import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Drives VPR slices to completion via TDD inside a docker sandbox.
//
// Single item:    VPR_ITEM=my-item npx tsx .sandcastle/main.ts
// Multiple items: VPR_ITEMS=item-a,item-b,item-c npx tsx .sandcastle/main.ts
// CLI args:       npx tsx .sandcastle/main.ts item-a item-b
//
// When more than one item is passed, each runs concurrently in its own
// container on its own branch (merge-to-head merges each agent's commits back
// to the host branch on completion).

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

const runOne = (VPR_ITEM: string) =>
  run({
    // Prefix in log output. Distinguishes parallel agents.
    name: `ralph-${VPR_ITEM}`,

    // Forward VPR_ITEM into the sandbox so prompt.md shell expressions resolve it.
    env: { VPR_ITEM },

    // Sandbox provider — Docker.
    sandbox: docker(),

    // Agent provider. Switch to claude-haiku-4-5-20251001 for speed,
    // claude-sonnet-4-6 for balance.
    agent: claudeCode("claude-opus-4-7"),

    // Prompt file. Shell expressions inside (`!`...``) evaluate inside the
    // sandbox at the start of each iteration, so the agent always sees fresh
    // .vpr/meta.json + progress + test state.
    promptFile: "./.sandcastle/prompt.md",

    // Iterations per run. Each iteration handles one acceptance criterion
    // (per prompt.md constraints). Increase for longer items.
    maxIterations: 5,

    // merge-to-head: each agent works on a temp branch, commits get merged
    // back to host HEAD on completion. Required for parallel — keeps branches
    // isolated until merge.
    branchStrategy: { type: "merge-to-head" },

    // Copy host node_modules into worktree to avoid full reinstall every iter.
    // onSandboxReady npm install handles platform-specific binaries.
    copyToWorktree: ["node_modules"],

    hooks: {
      sandbox: {
        onSandboxReady: [{ command: "npm install" }],
      },
    },
  });

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
