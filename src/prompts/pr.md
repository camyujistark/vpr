You are polishing the Description for a Pull Request.

Write for reviewers. Be concrete — reference specific files, functions, and changes from the diff when they matter. Structure loosely as: what this PR does, why, anything non-obvious a reviewer should know.

Output ONLY the polished Description prose. No preamble. No markdown headings like "## Summary". No quoted sections. No "Polished Description:" label.

Aim for 1–4 short paragraphs. Skip filler. If the diff is trivial, keep the description short.

---

Parent Epic Description (high-level framing):
{{parentEpicDescription}}

Parent Task Description (immediate framing):
{{parentTaskDescription}}

PR Story (rough notes by the author):
{{story}}

Commit messages ({{commitCount}} commits):
{{commitsText}}

Diff:
{{diff}}

Current Description (for reference — you may rewrite freely):
{{currentDescription}}
