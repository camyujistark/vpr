import { buildSendEditContent, parseSendEditContent } from '../tui/editor.mjs';

/**
 * Drive the `vpr send` editor loop for a single VPR.
 *
 * Opens the editor with the VPR's title/story, parses the saved buffer, and —
 * if the story changed — calls `regenerate` to refresh the output. Then asks
 * `prompt` for [y/N/e]: 'y' resolves with decision='send', 'e' re-opens the
 * editor, anything else resolves with decision='abandon'. Pure orchestration:
 * side effects (editor shell-out, LLM call, terminal prompt) are injected.
 *
 * @param {{
 *   vpr: { title?: string, story?: string, output?: string|null },
 *   openEditor: (initial: string) => string | Promise<string>,
 *   regenerate: (next: { title: string, story: string }) => string | Promise<string>,
 *   prompt?: (preview: { title: string, story: string, output: string|null }) => string | Promise<string>,
 * }} args
 * @returns {Promise<{ decision?: 'send'|'abandon', title: string, story: string, output: string|null }>}
 */
export async function runSendEditorFlow({ vpr, openEditor, regenerate, prompt }) {
  let current = { title: vpr.title ?? '', story: vpr.story ?? '', output: vpr.output ?? null };

  // Already-prepared VPRs (non-empty story + output) skip editor on first
  // pass and prompt directly — no wasted round-trip when story is already good.
  let skipEditor = current.story.trim() !== '' && current.output != null;

  while (true) {
    let parsed;
    if (skipEditor) {
      parsed = { title: current.title, story: current.story };
      skipEditor = false;
    } else {
      const edited = await openEditor(buildSendEditContent({ vpr: current }));
      parsed = parseSendEditContent(edited);
    }

    // Empty/whitespace story = abandon, matching `git commit` semantics. No
    // regenerate, no prompt — escaping the editor never accidentally pushes.
    if (parsed.story.trim() === '') {
      return { decision: 'abandon', title: parsed.title, story: parsed.story, output: current.output };
    }

    let output = current.output;
    if (parsed.story !== current.story) {
      output = await regenerate({ ...vpr, title: parsed.title, story: parsed.story });
    }

    current = { title: parsed.title, story: parsed.story, output };

    if (!prompt) return current;

    const answer = await prompt(current);
    if (answer === 'e') continue;
    return { decision: answer === 'y' ? 'send' : 'abandon', ...current };
  }
}
