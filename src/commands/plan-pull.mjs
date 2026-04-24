import fs from 'fs';

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderEpic(wi) {
  const lines = [`# Epic: ${wi.title} — PBI ${wi.id}`, ''];
  const story = htmlToText(wi.description);
  if (story) {
    lines.push('Story:', story, '');
  }
  lines.push('Description:', '');
  return lines.join('\n');
}

function renderTask(wi) {
  const lines = ['', `## Task: ${wi.title} — Task ${wi.id}`, ''];
  const story = htmlToText(wi.description);
  if (story) {
    lines.push('Story:', story, '');
  }
  lines.push('Description:', '');
  return lines.join('\n');
}

export function planPull({
  pbiId,
  planPath = 'plan.md',
  append = false,
  provider,
} = {}) {
  if (!provider) throw new Error('No provider configured');
  if (!pbiId) throw new Error('pbiId is required');

  const epic = provider.getWorkItem(pbiId);
  if (!epic) throw new Error(`PBI not found: ${pbiId}`);

  const children = (provider.getChildren ? provider.getChildren(pbiId) : [])
    .filter(c => c && (c.type === 'Task' || c.type === 'task'));

  if (fs.existsSync(planPath) && !append) {
    throw new Error(`${planPath} already exists. Use --append to add to it, or remove it first.`);
  }

  const sections = [renderEpic(epic)];
  for (const task of children) {
    sections.push(renderTask(task));
  }
  const body = sections.join('\n');

  if (append && fs.existsSync(planPath)) {
    const existing = fs.readFileSync(planPath, 'utf-8');
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(planPath, existing + separator + body);
  } else {
    fs.writeFileSync(planPath, body);
  }

  return {
    epicWi: epic.id,
    taskCount: children.length,
    written: planPath,
  };
}
