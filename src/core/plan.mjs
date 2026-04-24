import fs from 'fs';

const EPIC_RE = /^#\s+Epic:\s+(.+?)(?:\s+—\s+PBI\s+(\d+))?\s*$/;
const TASK_RE = /^##\s+Task:\s+(.+?)(?:\s+—\s+Task\s+(\d+))?\s*$/;
const PR_RE = /^###\s+PR:\s+(.+?)(?:\s+—\s+targets\s+(.+?))?\s*$/;
const STORY_RE = /^Story:\s*$/;
const DESC_RE = /^Description:\s*$/;
const COMMITS_RE = /^commits:\s+(.+?)\s*$/;

function headingLevel(line) {
  if (EPIC_RE.test(line)) return 1;
  if (TASK_RE.test(line)) return 2;
  if (PR_RE.test(line)) return 3;
  return null;
}

function isBlockTerminator(line) {
  return STORY_RE.test(line)
    || DESC_RE.test(line)
    || COMMITS_RE.test(line)
    || headingLevel(line) !== null;
}

export function parse(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');

  let epic = null;
  const tasks = [];
  let currentTask = null;
  let currentPr = null;
  let currentSection = null;
  let currentField = null;
  let buffer = [];

  function flushField() {
    if (currentField && currentSection) {
      currentSection[currentField] = buffer.join('\n').trim();
    }
    currentField = null;
    buffer = [];
  }

  for (const line of lines) {
    const epicMatch = line.match(EPIC_RE);
    if (epicMatch) {
      flushField();
      if (epic) throw new Error('Multiple epics in plan.md — only one allowed');
      epic = {
        title: epicMatch[1].trim(),
        wi: epicMatch[2] ? parseInt(epicMatch[2], 10) : null,
        wiType: epicMatch[2] ? 'PBI' : null,
        story: '',
        description: '',
      };
      currentTask = null;
      currentPr = null;
      currentSection = epic;
      continue;
    }

    const taskMatch = line.match(TASK_RE);
    if (taskMatch) {
      flushField();
      if (!epic) throw new Error('Task before Epic: every task must be under an epic');
      currentTask = {
        title: taskMatch[1].trim(),
        wi: taskMatch[2] ? parseInt(taskMatch[2], 10) : null,
        wiType: taskMatch[2] ? 'Task' : null,
        story: '',
        description: '',
        prs: [],
      };
      tasks.push(currentTask);
      currentPr = null;
      currentSection = currentTask;
      continue;
    }

    const prMatch = line.match(PR_RE);
    if (prMatch) {
      flushField();
      if (!currentTask) throw new Error('PR before Task: every PR must be under a task');
      const prev = currentTask.prs[currentTask.prs.length - 1];
      currentPr = {
        title: prMatch[1].trim(),
        targets: prMatch[2] ? prMatch[2].trim() : (prev ? prev.title : 'main'),
        commits: '',
        story: '',
        description: '',
      };
      currentTask.prs.push(currentPr);
      currentSection = currentPr;
      continue;
    }

    if (STORY_RE.test(line)) {
      flushField();
      currentField = 'story';
      buffer = [];
      continue;
    }

    if (DESC_RE.test(line)) {
      flushField();
      currentField = 'description';
      buffer = [];
      continue;
    }

    const commitsMatch = line.match(COMMITS_RE);
    if (commitsMatch) {
      flushField();
      if (currentPr) currentPr.commits = commitsMatch[1].trim();
      continue;
    }

    if (currentField) buffer.push(line);
  }
  flushField();

  if (!epic) throw new Error('No Epic heading found in plan.md');

  return { epic, tasks };
}

export function findSection(plan, { level, name }) {
  if (level === 'epic') return plan.epic;

  const pool = level === 'task'
    ? plan.tasks
    : plan.tasks.flatMap(t => t.prs);

  const exact = pool.filter(s => s.title === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Ambiguous ${level}: multiple sections titled "${name}"`);
  }

  const lower = name.toLowerCase();
  const partial = pool.filter(s => s.title.toLowerCase().includes(lower));
  if (partial.length === 0) return null;
  if (partial.length > 1) {
    throw new Error(`Ambiguous ${level}: "${name}" matches ${partial.map(m => `"${m.title}"`).join(', ')}`);
  }
  return partial[0];
}

function findSectionHeadingLine(lines, target) {
  if (target.level === 'epic') {
    for (let i = 0; i < lines.length; i++) {
      if (EPIC_RE.test(lines[i])) return i;
    }
    return -1;
  }

  const re = target.level === 'task' ? TASK_RE : PR_RE;
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) matches.push({ line: i, title: m[1].trim() });
  }

  const exact = matches.filter(m => m.title === target.name);
  if (exact.length === 1) return exact[0].line;
  if (exact.length > 1) {
    throw new Error(`Ambiguous ${target.level}: multiple sections titled "${target.name}"`);
  }

  const lower = (target.name || '').toLowerCase();
  const partial = matches.filter(m => m.title.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0].line;
  if (partial.length > 1) {
    throw new Error(`Ambiguous ${target.level}: "${target.name}" matches ${partial.map(m => `"${m.title}"`).join(', ')}`);
  }

  return -1;
}

export function writeDescription(filePath, target, newDescription) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');

  const sectionStart = findSectionHeadingLine(lines, target);
  if (sectionStart < 0) {
    throw new Error(`Section not found: ${target.level} "${target.name || ''}"`);
  }

  const sectionLevel = { epic: 1, task: 2, pr: 3 }[target.level];
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]);
    if (lvl !== null && lvl <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  // Find existing Description block within this section
  let descStart = -1;
  let descEnd = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (DESC_RE.test(lines[i])) {
      descStart = i;
      descEnd = sectionEnd;
      for (let j = i + 1; j < sectionEnd; j++) {
        if (isBlockTerminator(lines[j])) {
          descEnd = j;
          break;
        }
      }
      break;
    }
  }

  let newLines;
  if (descStart >= 0) {
    const before = lines.slice(0, descStart);
    const after = lines.slice(descEnd);
    const replaced = ['Description:', '', newDescription, ''];
    newLines = [...before, ...replaced, ...after];
  } else {
    // No existing Description — insert after Story block (or after heading if no Story)
    let insertPoint = sectionStart + 1;
    while (insertPoint < sectionEnd && lines[insertPoint] === '') insertPoint++;

    if (insertPoint < sectionEnd && STORY_RE.test(lines[insertPoint])) {
      // skip the Story: label
      let j = insertPoint + 1;
      while (j < sectionEnd && !isBlockTerminator(lines[j])) j++;
      insertPoint = j;
    }

    const insertion = ['Description:', '', newDescription, ''];
    newLines = [...lines.slice(0, insertPoint), ...insertion, ...lines.slice(insertPoint)];
  }

  fs.writeFileSync(filePath, newLines.join('\n'));
}
