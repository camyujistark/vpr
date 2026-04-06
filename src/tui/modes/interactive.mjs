import { execSync } from 'child_process';
import { getFiles } from '../../core/jj.mjs';
import { appendEvent } from '../../core/meta.mjs';
import { openEditor, buildInteractiveContent, parseInteractiveContent } from '../editor.mjs';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: 'inherit' };

/**
 * Open $EDITOR with a rebase-i style commit list. Executes the selected
 * actions (squash, drop, reword) in reverse order (newest first).
 *
 * @param {string} vprBookmark
 * @param {Array<{ changeId: string, sha: string, subject: string, conflict: boolean }>} commits
 * @param {{ reload: Function, render: Function, setMessage: Function }} context
 */
export async function openInteractive(vprBookmark, commits, context) {
  // 1. Augment commits with file lists
  const commitsWithFiles = commits.map(commit => ({
    ...commit,
    files: getFiles(commit.changeId),
  }));

  // 2. Build editor content
  const initial = buildInteractiveContent(commitsWithFiles);

  // 3. Open editor, parse result
  let parsed = null;
  openEditor(initial, content => {
    parsed = parseInteractiveContent(content);
  });

  if (!parsed || parsed.length === 0) return;

  // 4. Execute non-pick actions in reverse order (newest first)
  const nonPick = parsed.filter(e => e.action !== 'pick').reverse();

  const counts = { squash: 0, drop: 0, reword: 0 };

  for (const entry of nonPick) {
    const { action, changeId, newMessage, subject } = entry;

    try {
      if (action === 'squash') {
        execSync(`jj squash -r ${changeId}`, { ...EXEC_OPTS, env: { ...process.env, JJ_EDITOR: 'true' } });
        counts.squash++;
        await appendEvent('tui', 'squash', { vprBookmark, changeId });
      } else if (action === 'drop') {
        execSync(`jj abandon ${changeId}`, EXEC_OPTS);
        counts.drop++;
        await appendEvent('tui', 'drop', { vprBookmark, changeId });
      } else if (action === 'reword') {
        // Use newMessage if the user provided a quoted message; fall back to subject
        const message = (newMessage || subject || '').replace(/'/g, "'\\''");
        execSync(`jj describe ${changeId} -m '${message}'`, EXEC_OPTS);
        counts.reword++;
        await appendEvent('tui', 'reword', { vprBookmark, changeId, message: newMessage || subject });
      }
    } catch {
      // Continue with remaining actions even if one fails
    }
  }

  // 5. Reload + render + message
  await context.reload();
  context.render();

  const total = nonPick.length;
  const parts = [];
  if (counts.squash) parts.push(`${counts.squash} squash`);
  if (counts.drop) parts.push(`${counts.drop} drop`);
  if (counts.reword) parts.push(`${counts.reword} reword`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  context.setMessage(`Applied ${total} action${total !== 1 ? 's' : ''}${detail}`);
}
