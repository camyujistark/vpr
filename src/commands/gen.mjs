import { parse, writeDescription } from '../core/plan.mjs';
import { buildContext, renderPrompt, loadPrompt } from '../core/gen-context.mjs';
import { runLLM } from '../core/llm.mjs';
import { editInEditor } from '../core/editor.mjs';

export function gen({
  level,
  name,
  planPath = 'plan.md',
  dry = false,
  pipe = false,
  fresh = false,
  yes = false,
  deps = {},
} = {}) {
  const plan = parse(planPath);
  const target = { level, name };

  const context = buildContext({ level, name, plan, deps });
  if (fresh) context.currentDescription = '';

  const template = loadPrompt(level);
  const prompt = renderPrompt(template, context);

  if (pipe) {
    return { status: 'pipe', level, name, prompt };
  }

  const llmOutput = runLLM(prompt, {
    runShell: deps.runShell,
    env: deps.env,
  });

  if (dry) {
    return { status: 'dry', level, name, content: llmOutput };
  }

  let finalContent = llmOutput;
  if (!yes) {
    const edited = editInEditor(llmOutput, {
      runEditor: deps.runEditor,
      env: deps.env,
    });
    if (edited === null) {
      return { status: 'discarded', level, name };
    }
    finalContent = edited;
  }

  writeDescription(planPath, target, finalContent.trim());
  return { status: 'written', level, name, content: finalContent };
}

export function genAll({
  planPath = 'plan.md',
  dry = false,
  pipe = false,
  fresh = false,
  yes = false,
  deps = {},
} = {}) {
  const plan = parse(planPath);
  const targets = [];

  targets.push({ level: 'epic', name: null, story: plan.epic.story });
  for (const task of plan.tasks) {
    targets.push({ level: 'task', name: task.title, story: task.story });
    for (const pr of task.prs) {
      targets.push({ level: 'pr', name: pr.title, story: pr.story });
    }
  }

  const results = [];
  for (const t of targets) {
    if (!t.story.trim()) {
      results.push({ status: 'skipped-no-story', level: t.level, name: t.name });
      continue;
    }
    try {
      const r = gen({
        level: t.level, name: t.name, planPath,
        dry, pipe, fresh, yes, deps,
      });
      results.push(r);
    } catch (err) {
      results.push({ status: 'error', level: t.level, name: t.name, error: err.message });
    }
  }
  return results;
}
