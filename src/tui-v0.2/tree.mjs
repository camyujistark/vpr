export function flattenPlan(plan) {
  const nodes = [];
  nodes.push({
    level: 'epic',
    title: plan.epic.title,
    depth: 0,
    node: plan.epic,
  });
  for (const task of plan.tasks) {
    nodes.push({
      level: 'task',
      title: task.title,
      depth: 1,
      node: task,
    });
    for (const pr of task.prs) {
      nodes.push({
        level: 'pr',
        title: pr.title,
        depth: 2,
        node: pr,
        parentTaskTitle: task.title,
      });
    }
  }
  return nodes;
}
