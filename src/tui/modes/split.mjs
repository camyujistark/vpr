import { execSync } from 'child_process';
import { getFiles } from '../../core/jj.mjs';
import { appendEvent } from '../../core/meta.mjs';
import { openEditor } from '../editor.mjs';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: 'inherit' };

/**
 * Open $EDITOR with a file list for the given commit. Files marked with
 * `split` are moved to a new commit via `jj split`.
 *
 * @param {string} changeId
 * @param {{ reload: Function, render: Function, setMessage: Function }} context
 */
export async function openSplit(changeId, context) {
  // 1. Get files for the commit
  const files = getFiles(changeId);

  if (files.length === 0) {
    context.setMessage('No files in commit');
    return;
  }

  // 2. Build editor content
  const short = changeId.slice(0, 8);
  const lines = [
    `# Select files to split out of ${short}`,
    `# Change 'pick' to 'split' for files to move to a new commit`,
    `# Save and close to apply`,
    '#',
    ...files.map(f => `pick ${f}`),
  ];
  const initial = lines.join('\n');

  // 3. Open editor, parse result
  let splitFiles = null;
  openEditor(initial, content => {
    const toSplit = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('split ')) {
        // Strip the action keyword and the status letter (e.g. "A ", "M ")
        const rest = line.slice('split '.length).trim(); // "A path/to/file"
        const path = rest.replace(/^\S+\s+/, '');         // "path/to/file"
        if (path) toSplit.push(path);
      }
    }
    splitFiles = toSplit;
  });

  if (!splitFiles || splitFiles.length === 0) return;

  // 4. Execute jj split with the selected files
  const filePaths = splitFiles.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  try {
    execSync(`jj split -r ${changeId} ${filePaths}`, {
      ...EXEC_OPTS,
      env: { ...process.env, JJ_EDITOR: 'true' },
    });
  } catch {
    context.setMessage('jj split failed');
    await context.reload();
    context.render();
    return;
  }

  // 5. Append event, reload, render, message
  await appendEvent('tui', 'split', { changeId, files: splitFiles });
  await context.reload();
  context.render();
  context.setMessage(`Split ${splitFiles.length} file${splitFiles.length !== 1 ? 's' : ''} into new commit`);
}
