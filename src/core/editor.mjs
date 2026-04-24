import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

function defaultRunEditor(editor, tmpFile) {
  execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
}

function tmpFilePath(suffix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `ship-${process.pid}-${Date.now()}-${rand}${suffix}`);
}

export function editInEditor(initialContent, {
  env = process.env,
  editor,
  runEditor = defaultRunEditor,
  suffix = '.md',
} = {}) {
  const chosenEditor = editor || env.EDITOR || 'vi';
  const tmpFile = tmpFilePath(suffix);
  fs.writeFileSync(tmpFile, initialContent);
  try {
    runEditor(chosenEditor, tmpFile);
    const final = fs.readFileSync(tmpFile, 'utf-8');
    if (final.trim() === '') return null;
    return final;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* already gone is fine */ }
  }
}
