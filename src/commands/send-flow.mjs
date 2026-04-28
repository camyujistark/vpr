import { buildSendEditContent, parseSendEditContent } from '../tui/editor.mjs';

/**
 * Drive the `vpr send` editor loop for a single VPR.
 *
 * Opens the editor with the VPR's title/story, parses the saved buffer, and —
 * if the story changed — calls `regenerate` to refresh the output before the
 * caller shows a preview. Pure orchestration: side effects (editor shell-out,
 * LLM call) are injected.
 *
 * @param {{
 *   vpr: { title?: string, story?: string, output?: string|null },
 *   openEditor: (initial: string) => string | Promise<string>,
 *   regenerate: (next: { title: string, story: string }) => string | Promise<string>,
 * }} args
 * @returns {Promise<{ title: string, story: string, output: string|null }>}
 */
export async function runSendEditorFlow({ vpr, openEditor, regenerate }) {
  const initial = buildSendEditContent({ vpr });
  const edited = await openEditor(initial);
  const parsed = parseSendEditContent(edited);

  let output = vpr.output ?? null;
  if (parsed.story !== (vpr.story ?? '')) {
    output = await regenerate({ ...vpr, title: parsed.title, story: parsed.story });
  }

  return { title: parsed.title, story: parsed.story, output };
}
