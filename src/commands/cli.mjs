/**
 * VPR CLI commands — scriptable interface for AI and automation.
 * Each function is a self-contained command that reads config/meta, does work, outputs JSON.
 */

import { execSync } from 'child_process';
import readline from 'readline';
import { loadConfig, loadMeta, saveMeta, loadRebaseLog } from '../config.mjs';
import { jj, jjSafe, hasJj, getBase, getDiffForCommit } from '../git.mjs';
import { createProvider } from '../providers/index.mjs';
import { loadEntries, groupEntries, findBookmark, resolveToBookmark } from '../entries.mjs';

function requireJj() {
  if (!hasJj()) { console.error('VPR requires jj (jujutsu)'); process.exit(1); }
}

function requireConfig() {
  const config = loadConfig();
  if (!config) { console.error('VPR not initialized. Run `vpr init` first.'); process.exit(1); }
  return config;
}

function slugify(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-').slice(0, 4).join('-');
}

// ── vpr new "title" "description" ──────────────────────────────────────
export function cmdNew(args) {
  requireJj();
  const config = requireConfig();
  const provider = createProvider(config);
  const meta = loadMeta();

  const title = args[0];
  const desc = args[1] || '';
  if (!title) { console.error('Usage: vpr new "title" ["description"]'); process.exit(1); }

  // Find target commit: explicit arg > @ if described > @- if not
  // Always ensure linear chain — if @ is not on the chain tip, use @-
  let target = args[2];
  if (!target) {
    const atDesc = jjSafe(`log --no-graph -r @ -T 'description.first_line()'`)?.trim();
    target = atDesc ? '@' : '@-';
  }

  const wi = provider.createWorkItem(title, desc);
  if (!wi?.id) { console.error('Failed to create work item'); process.exit(1); }

  const prefix = config.prefix || 'TP';
  const idx = meta.nextIndex || 1;
  const tpIndex = `${prefix}-${idx}`;
  const slug = slugify(title);
  const bm = `feat/${wi.id}-${slug}`;

  meta.nextIndex = idx + 1;

  // Create jj bookmark
  jj(`bookmark create ${bm} -r ${target}`);

  if (!meta.bookmarks) meta.bookmarks = {};
  meta.bookmarks[bm] = {
    wi: wi.id,
    wiTitle: title,
    wiDescription: desc,
    wiState: 'New',
    tpIndex,
    prTitle: `${tpIndex}: ${title}`,
  };
  saveMeta(meta);

  console.log(JSON.stringify({ bookmark: bm, wi: wi.id, tpIndex, prTitle: `${tpIndex}: ${title}` }));
}

// ── vpr edit <bookmark> --title|--desc|--pr-title|--pr-desc "value" ────
export function cmdEdit(args) {
  const config = requireConfig();
  const meta = loadMeta();

  const bookmark = findBookmark(meta, args[0]);
  if (!bookmark) { console.error(`Bookmark not found: ${args[0]}`); process.exit(1); }

  const bmMeta = meta.bookmarks[bookmark];
  let changed = false;

  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const val = args[i + 1];
    if (!val && val !== '') { console.error(`Missing value for ${flag}`); process.exit(1); }

    switch (flag) {
      case '--title':
        bmMeta.wiTitle = val;
        // Rename bookmark slug
        if (bmMeta.wi) {
          const newBm = `feat/${bmMeta.wi}-${slugify(val)}`;
          if (newBm !== bookmark) {
            try {
              jj(`bookmark rename ${bookmark} ${newBm}`);
              meta.bookmarks[newBm] = bmMeta;
              delete meta.bookmarks[bookmark];
            } catch {}
          }
        }
        if (bmMeta.tpIndex) bmMeta.prTitle = `${bmMeta.tpIndex}: ${val}`;
        changed = true;
        break;
      case '--desc':
        bmMeta.wiDescription = val;
        changed = true;
        break;
      case '--pr-title':
        bmMeta.prTitle = val;
        changed = true;
        break;
      case '--pr-desc':
        bmMeta.prDesc = val;
        changed = true;
        break;
      case '--state':
        bmMeta.wiState = val;
        changed = true;
        break;
      default:
        console.error(`Unknown flag: ${flag}. Use --title, --desc, --pr-title, --pr-desc, --state`);
        process.exit(1);
    }
  }

  if (changed) {
    saveMeta(meta);
    // Sync to provider if title/desc changed
    const provider = createProvider(config);
    if (bmMeta.wi) {
      try { provider.updateWorkItem(bmMeta.wi, { title: bmMeta.wiTitle, description: bmMeta.wiDescription }); } catch {}
    }
  }

  console.log(JSON.stringify(meta.bookmarks[findBookmark(meta, args[0]) || bookmark] || bmMeta));
}

// ── vpr move <changeId> --after|--before <targetId> ────────────────────
export function cmdMove(args) {
  requireJj();
  const changeId = args[0];
  const flag = args[1]; // --after or --before
  const targetId = args[2];

  if (!changeId || !flag || !targetId) {
    console.error('Usage: vpr move <changeId> --after|--before <targetId>');
    process.exit(1);
  }

  const jjFlag = flag === '--before' ? '-B' : '-A';
  jj(`rebase -r ${changeId} ${jjFlag} ${targetId}`);
  console.log(JSON.stringify({ moved: changeId, flag, target: targetId }));
}

// ── vpr delete <changeId-or-bookmark> ──────────────────────────────────
export function cmdDelete(args) {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const target = args[0];

  if (!target) { console.error('Usage: vpr delete <changeId-or-bookmark>'); process.exit(1); }

  // Check if it's a bookmark
  const bookmark = findBookmark(meta, target);
  if (bookmark) {
    // Delete group + all commits
    const base = getBase() || 'main';
    const entries = loadEntries(base);
    const groupCommits = getGroupCommits(entries, bookmark, meta);
    for (const c of groupCommits) {
      try { jj(`abandon ${c.changeId}`); } catch {}
    }
    try { jj(`bookmark delete ${bookmark}`); } catch {}
    if (meta.bookmarks?.[bookmark]) delete meta.bookmarks[bookmark];
    saveMeta(meta);
    console.log(JSON.stringify({ deleted: bookmark, commits: groupCommits.length }));
  } else {
    // Delete single commit
    jj(`abandon ${target}`);
    console.log(JSON.stringify({ abandoned: target }));
  }
}

// ── vpr list ───────────────────────────────────────────────────────────
export function cmdList() {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base, { files: true });
  const groups = groupEntries(entries, meta);

  const result = groups.map((g, i) => {
    const bmMeta = g.bookmark ? (meta.bookmarks?.[g.bookmark] || {}) : {};
    const prevGroup = i > 0 ? groups[i - 1] : null;
    return {
      bookmark: g.bookmark,
      tpIndex: bmMeta.tpIndex || null,
      wi: bmMeta.wi || null,
      wiTitle: bmMeta.wiTitle || null,
      prTitle: bmMeta.prTitle || null,
      prDesc: bmMeta.prDesc || null,
      prBody: bmMeta.prBody || null,
      target: prevGroup?.bookmark || resolveToBookmark(base),
      commits: g.commits.map(c => ({
        changeId: c.changeId,
        sha: c.sha,
        subject: c.subject,
      })),
    };
  });

  const done = Object.entries(meta.done || {}).map(([bm, m]) => ({
    bookmark: bm,
    tpIndex: m.tpIndex || null,
    wi: m.wi || null,
    wiTitle: m.wiTitle || null,
    prTitle: m.prTitle || null,
    prId: m.prId || null,
  }));

  const rebaseLog = loadRebaseLog();
  const lastRebase = rebaseLog.length > 0 ? rebaseLog[rebaseLog.length - 1] : null;

  const hold = meta.hold || [];
  console.log(JSON.stringify({ groups: result, done, hold, lastRebase }, null, 2));
}

// ── vpr status ─────────────────────────────────────────────────────────
export function cmdStatus() {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base, { files: true });
  const groups = groupEntries(entries, meta);
  const resolvedBase = resolveToBookmark(base);
  const totalGroups = groups.filter(g => g.bookmark).length;

  const C = '\x1b[36m';   // cyan
  const G = '\x1b[32m';   // green
  const Y = '\x1b[33m';   // yellow
  const M = '\x1b[35m';   // magenta
  const D = '\x1b[2m';    // dim
  const B = '\x1b[1m';    // bold
  const R = '\x1b[0m';    // reset
  const RED = '\x1b[31m';
  const W = '\x1b[37m';   // white

  console.log(`\n  ${B}${totalGroups} virtual PRs${R}\n`);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.bookmark) continue;
    const m = meta.bookmarks?.[g.bookmark] || {};
    const target = i > 0 ? groups[i - 1].bookmark : resolvedBase;
    const tp = m.tpIndex || '';
    const wi = m.wi ? `#${m.wi}` : '';
    const prTitle = m.prTitle || '';
    const totalFiles = g.commits.reduce((n, c) => n + (c.files?.length || 0), 0);

    // Header line
    console.log(`  ${C}${B}${tp}${R} ${D}${wi}${R}  ${W}${B}${m.wiTitle || g.bookmark}${R}`);
    // Branch → target
    console.log(`  ${G}${g.bookmark}${R} ${D}→${R} ${D}${target}${R}`);
    // PR title
    if (prTitle) console.log(`  ${Y}PR: ${prTitle}${R}`);
    // Stats
    console.log(`  ${D}${g.commits.length} commit${g.commits.length !== 1 ? 's' : ''} · ${totalFiles} file${totalFiles !== 1 ? 's' : ''}${R}`);

    // Commits + files
    for (const c of g.commits) {
      console.log(`  ${D}│${R} ${M}${c.changeId.slice(0, 8)}${R}  ${c.subject}`);
      for (const f of (c.files || [])) {
        const type = f.charAt(0);
        const color = type === 'A' ? G : type === 'D' ? RED : D;
        console.log(`  ${D}│${R}            ${color}${f}${R}`);
      }
    }
    console.log(`  ${D}│${R}`);
    console.log('');
  }

  // Ungrouped
  const ungrouped = groups.find(g => !g.bookmark);
  if (ungrouped && ungrouped.commits.length > 0) {
    console.log(`  ${M}${B}⚠ Ungrouped (${ungrouped.commits.length})${R}`);
    for (const c of ungrouped.commits) {
      console.log(`  ${D}│${R} ${M}${c.changeId.slice(0, 8)}${R}  ${c.subject}`);
    }
    console.log('');
  }

  // Done
  const doneCount = Object.keys(meta.done || {}).length;
  if (doneCount > 0) {
    console.log(`  ${D}${doneCount} done${R}\n`);
  }

  // Last rebase
  const rebaseLog = loadRebaseLog();
  if (rebaseLog.length > 0) {
    const last = rebaseLog[rebaseLog.length - 1];
    const ago = Math.round((Date.now() - new Date(last.timestamp).getTime()) / 60000);
    if (ago < 60) {
      const types = {};
      for (const a of last.actions) types[a.type] = (types[a.type] || 0) + 1;
      const summary = Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ');
      console.log(`  ${D}Last rebase: ${last.actions.length} actions (${summary}) — ${ago}m ago${R}\n`);
    }
  }
}

// ── vpr push ───────────────────────────────────────────────────────────
export function cmdPush(args) {
  requireJj();
  const meta = loadMeta();
  const bookmarks = Object.keys(meta.bookmarks || {});

  if (bookmarks.length === 0) { console.log('No bookmarks to push'); return; }

  const specific = args[0];
  const toPush = specific ? [findBookmark(meta, specific)].filter(Boolean) : bookmarks;

  for (const bm of toPush) {
    try {
      jj(`git push --bookmark ${bm}`);
      console.log(`Pushed: ${bm}`);
    } catch (err) {
      console.error(`Failed to push ${bm}: ${err?.stderr?.toString()?.slice(0, 80) || err.message}`);
    }
  }
}

// ── vpr send [id] [--dry-run] ─────────────────────────────────────────
export async function cmdSend(args) {
  requireJj();
  const config = requireConfig();
  let meta = loadMeta();
  const base = getBase() || 'main';
  const dryRun = args.includes('--dry-run');
  const specificId = args.find(a => a !== '--dry-run');

  // Auto-linearize before sending
  const conflictsBefore = (jjSafe(`log --no-graph -r 'conflicts()' -T 'x'`) || '').length;
  if (conflictsBefore > 0) {
    console.error(`⚠ ${conflictsBefore} conflict(s) in the chain. Resolve before sending.`);
    if (!dryRun) process.exit(1);
  }
  // Check for forks and auto-linearize
  await cmdLinearize(['--auto']);
  meta = loadMeta(); // reload after linearize may have renumbered

  const entries = loadEntries(base);
  const groups = groupEntries(entries, meta);

  // Filter to specific ID if provided
  let sendGroups = groups.filter(g => g.bookmark);
  if (specificId) {
    const bm = findBookmark(meta, specificId);
    if (!bm) { console.error(`Not found: ${specificId}`); process.exit(1); }
    const targetGroup = sendGroups.find(g => g.bookmark === bm);
    if (!targetGroup) { console.error(`No commits for ${specificId}`); process.exit(1); }
    // Find the target branch (previous group in full chain)
    const idx = sendGroups.indexOf(targetGroup);
    const target = idx > 0 ? sendGroups[idx - 1].bookmark : resolveToBookmark(base);
    targetGroup._target = target;
    sendGroups = [targetGroup];
  }

  if (sendGroups.length === 0) { console.log('No groups to send'); return; }

  // Validation
  let hasErrors = false;
  for (const g of sendGroups) {
    const m = meta.bookmarks?.[g.bookmark] || {};
    if (!m.prTitle) { console.error(`Missing PR title for ${m.tpIndex || g.bookmark}`); hasErrors = true; }
    if (!m.wi) { console.error(`Missing work item for ${m.tpIndex || g.bookmark}`); hasErrors = true; }
  }
  if (hasErrors && !dryRun) { console.error('\nFix missing fields before sending.'); process.exit(1); }

  // Chain order validation — each bookmark's ancestors up to its target
  // should only contain commits from that group, not from other groups.
  const chainErrors = validateChainOrder(groups, meta, base);
  if (chainErrors.length > 0) {
    console.error('\n⚠ Chain order mismatch — bookmarks contain commits from other groups:\n');
    for (const err of chainErrors) console.error(`  ${err}`);
    console.error('\nReorder commits so each group is contiguous before sending.');
    if (!dryRun) process.exit(1);
  }

  // Show chain
  console.log(`\n=== ${dryRun ? 'DRY RUN' : 'SEND'}: ${sendGroups.length} PR${sendGroups.length !== 1 ? 's' : ''} ===\n`);

  for (let i = 0; i < sendGroups.length; i++) {
    const g = sendGroups[i];
    const m = meta.bookmarks?.[g.bookmark] || {};
    const allIdx = groups.findIndex(gr => gr.bookmark === g.bookmark);
    const target = g._target || (allIdx > 0 ? groups[allIdx - 1]?.bookmark : resolveToBookmark(base));

    console.log(`--- PR ${i + 1}: ${m.tpIndex || ''} ---`);
    console.log(`  Branch:  ${g.bookmark}`);
    console.log(`  Target:  ${target}`);
    console.log(`  WI:      #${m.wi || '?'}`);
    console.log(`  Title:   ${m.prTitle || '(not set)'}`);
    if (m.prDesc) {
      console.log(`  Body:    ${m.prDesc.split('\n')[0]}${m.prDesc.includes('\n') ? '...' : ''}`);
    }
    console.log(`  Commits: ${g.commits.length}`);
    for (const c of g.commits) {
      console.log(`    ${c.changeId.slice(0, 8)} ${c.subject}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Dry run complete. Run `vpr send` to push.');
    return;
  }

  // Push and create PRs
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (let i = 0; i < sendGroups.length; i++) {
    const g = sendGroups[i];
    const m = meta.bookmarks?.[g.bookmark] || {};
    const allIdx = groups.findIndex(gr => gr.bookmark === g.bookmark);
    const target = g._target || (allIdx > 0 ? groups[allIdx - 1]?.bookmark : resolveToBookmark(base));

    // Push
    console.log(`\nPushing ${m.tpIndex || g.bookmark}...`);
    try {
      jj(`git push --bookmark ${g.bookmark}`);
      console.log(`  Pushed: ${g.bookmark}`);
    } catch (err) {
      console.error(`  Failed to push: ${err?.stderr?.toString()?.slice(0, 80) || err.message}`);
      const answer = await new Promise(r => rl.question('  Continue? (y/n) ', r));
      if (answer !== 'y') { rl.close(); process.exit(1); }
      continue;
    }

    // Create PR via provider
    const provider = createProvider(config);
    try {
      const prBody = m.prBody || m.prDesc || '';
      const prResult = provider.createPR(g.bookmark, target, m.prTitle || '', prBody, m.wi);
      console.log(`  PR created: #${prResult.id}`);

      // Close work item
      if (m.wi) {
        try {
          const doneState = config.provider === 'github' ? 'Closed' : 'Done';
          provider.updateWorkItem(m.wi, { state: doneState });
          console.log(`  WI #${m.wi} → ${doneState}`);
        } catch {}
      }

      // Move bookmark to done
      if (!meta.done) meta.done = {};
      meta.done[g.bookmark] = { ...m, prId: prResult.id };
      delete meta.bookmarks[g.bookmark];
      saveMeta(meta);
      console.log(`  Moved ${m.tpIndex || g.bookmark} → done`);
    } catch (err) {
      console.error(`  Failed to create PR: ${err?.stderr?.toString()?.slice(0, 100) || err.message}`);
    }
  }

  rl.close();
  console.log('\nDone.');
}

// ── vpr clean ─────────────────────────────────────────────────────────
export function cmdClean() {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base);
  const moved = [];

  for (const [bm, bmMeta] of Object.entries(meta.bookmarks || {})) {
    // Check if this bookmark has any commits in the current chain
    const hasCommits = entries.some(e => e.bookmark === bm);
    if (!hasCommits) {
      if (!meta.done) meta.done = {};
      meta.done[bm] = bmMeta;
      delete meta.bookmarks[bm];
      moved.push(bmMeta.tpIndex || bm);
    }
  }

  if (moved.length > 0) {
    saveMeta(meta);
    console.log(`Moved ${moved.length} to done: ${moved.join(', ')}`);
  } else {
    console.log('Nothing to clean');
  }
}

// ── vpr squash <changeId> ──────────────────────────────────────────────
export function cmdSquash(args) {
  requireJj();
  const changeId = args[0];
  if (!changeId) { console.error('Usage: vpr squash <changeId>'); process.exit(1); }
  jj(`squash -r ${changeId}`);
  console.log(JSON.stringify({ squashed: changeId }));
}

// ── vpr split <changeId> ──────────────────────────────────────────────
export function cmdSplit(args) {
  requireJj();
  const changeId = args[0];
  if (!changeId) { console.error('Usage: vpr split <changeId>'); process.exit(1); }
  // Split needs interactive diff editor
  execSync(`jj split -r ${changeId}`, { stdio: 'inherit', shell: '/bin/bash' });
  console.log(JSON.stringify({ split: changeId }));
}

// ── vpr generate <id> ─────────────────────────────────────────────────
export function cmdGenerate(args) {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const target = args[0];

  if (!target) { console.error('Usage: vpr generate <id>'); process.exit(1); }

  const bookmark = findBookmark(meta, target);
  if (!bookmark) { console.error(`Not found: ${target}`); process.exit(1); }

  const bmMeta = meta.bookmarks[bookmark];
  if (!bmMeta.prDesc?.trim()) {
    console.error(`No PR story for ${bmMeta.tpIndex || bookmark}. Set it with: vpr edit ${target} --pr-desc "..."`);
    process.exit(1);
  }

  // Find generate command
  let cmd = config.generateCmd || null;
  if (!cmd) {
    try { execSync('which claude', { stdio: 'pipe' }); cmd = 'claude -p'; } catch {}
  }
  if (!cmd) {
    console.error('No LLM configured. Add "generateCmd" to .vpr/config.json or install claude CLI');
    process.exit(1);
  }

  // Build prompt
  const base = getBase() || 'main';
  const entries = loadEntries(base, { files: true });
  const groups = groupEntries(entries, meta);
  const group = groups.find(g => g.bookmark === bookmark);
  const commitList = (group?.commits || []).map(c => `- ${c.changeId?.slice(0, 8)} ${c.subject}`).join('\n');

  const prompt = [
    'Generate a concise PR description in markdown from the following.',
    'Output ONLY the description body — no preamble, no "Here is", just the markdown.',
    'Use ## Summary with 1-3 bullet points, then ## Changes with details grouped logically.',
    '',
    `PR Title: ${bmMeta.prTitle || ''}`,
    '',
    'PR Story:',
    bmMeta.prDesc,
    '',
    'Commits:',
    commitList,
  ].join('\n');

  console.error(`Generating PR description for ${bmMeta.tpIndex || bookmark}...`);

  try {
    const result = execSync(cmd, {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: '/bin/bash',
    }).trim();

    if (!result) {
      console.error('LLM returned empty response');
      process.exit(1);
    }

    bmMeta.prBody = result;
    saveMeta(meta);
    console.log(JSON.stringify({ bookmark, generated: true, prBody: result }));
  } catch (err) {
    console.error(`Generation failed: ${err?.stderr?.toString()?.slice(0, 100) || err.message}`);
    process.exit(1);
  }
}

// ── vpr hold <changeId> ───────────────────────────────────────────────
export function cmdHold(args) {
  const meta = loadMeta();
  const changeId = args[0];
  if (!changeId) { console.error('Usage: vpr hold <changeId>'); process.exit(1); }

  if (!meta.hold) meta.hold = [];
  if (meta.hold.includes(changeId)) {
    console.log(JSON.stringify({ hold: changeId, status: 'already held' }));
    return;
  }
  meta.hold.push(changeId);
  saveMeta(meta);
  console.log(JSON.stringify({ hold: changeId, status: 'held' }));
}

// ── vpr unhold <changeId> ─────────────────────────────────────────────
export function cmdUnhold(args) {
  const meta = loadMeta();
  const changeId = args[0];
  if (!changeId) { console.error('Usage: vpr unhold <changeId>'); process.exit(1); }

  if (!meta.hold) meta.hold = [];
  const idx = meta.hold.indexOf(changeId);
  if (idx < 0) {
    // Try partial match
    const match = meta.hold.find(h => h.startsWith(changeId));
    if (match) {
      meta.hold.splice(meta.hold.indexOf(match), 1);
      saveMeta(meta);
      console.log(JSON.stringify({ unhold: match, status: 'released' }));
      return;
    }
    console.log(JSON.stringify({ unhold: changeId, status: 'not held' }));
    return;
  }
  meta.hold.splice(idx, 1);
  saveMeta(meta);
  console.log(JSON.stringify({ unhold: changeId, status: 'released' }));
}

// ── vpr linearize ─────────────────────────────────────────────────────
export async function cmdLinearize(args) {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const dryRun = args.includes('--dry-run');
  const auto = args.includes('--auto');

  // Detect forks: find commits with multiple children in the chain
  const range = `${base}..(visible_heads() & descendants(${base}))`;
  const raw = jjSafe(`log --no-graph --reversed -r '${range}' -T 'change_id.short() ++ "\\t" ++ parents.map(|p| p.change_id().short()).join(",") ++ "\\n"'`);
  if (!raw) { console.log('Nothing to linearize'); return; }

  // Build parent→children map
  const children = new Map();
  const allIds = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('\t')) continue;
    const [cid, parentsStr] = line.split('\t');
    allIds.push(cid.trim());
    for (const pid of parentsStr.split(',').filter(Boolean)) {
      const p = pid.trim();
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(cid.trim());
    }
  }

  // Find fork points — parents with multiple children in the chain
  const forks = [];
  for (const [parent, kids] of children) {
    if (kids.length > 1) {
      forks.push({ parent, children: kids });
    }
  }

  if (forks.length === 0) {
    console.log('Chain is already linear — no forks detected.');
    return;
  }

  console.log(`\nFound ${forks.length} fork(s) in the chain:\n`);
  for (const f of forks) {
    const parentDesc = jjSafe(`log --no-graph -r '${f.parent}' -T 'description.first_line()'`)?.trim() || '';
    console.log(`  ${f.parent.slice(0, 8)}: ${parentDesc}`);
    console.log(`    → ${f.children.length} branches:`);
    for (const kid of f.children) {
      const kidDesc = jjSafe(`log --no-graph -r '${kid}' -T 'description.first_line()'`)?.trim() || '';
      console.log(`      ${kid.slice(0, 8)}: ${kidDesc}`);
    }
    console.log('');
  }

  if (!auto) console.log('Linearize will rebase sibling branches onto the main line sequentially.');
  if (dryRun) { console.log('Dry run — no changes.'); return; }

  if (!auto) {
    const rl = (await import('readline')).createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question('Apply? (y/n) ', r));
    rl.close();
    if (answer !== 'y') { console.log('Cancelled.'); return; }
  }

  // For each fork, pick the "main" child (the one with more descendants or the first in chain order)
  // and rebase the other children after the main branch's tip
  let rebased = 0;
  for (const f of forks) {
    // Find which child has the most descendants — that's the main line
    let mainChild = f.children[0];
    let mainCount = 0;
    for (const kid of f.children) {
      const count = parseInt(jjSafe(`log --no-graph -r 'descendants(${kid})' -T '"x"'`)?.length || '0');
      if (count > mainCount) { mainCount = count; mainChild = kid; }
    }

    // Rebase other children after the last descendant of the main child
    const mainTip = jjSafe(`log --no-graph -r 'heads(descendants(${mainChild}))' -T 'change_id.short()' --limit 1`)?.trim();
    if (!mainTip) continue;

    for (const kid of f.children) {
      if (kid === mainChild) continue;
      try {
        jj(`rebase -s ${kid} -A ${mainTip}`);
        rebased++;
        console.log(`  Rebased ${kid.slice(0, 8)} after ${mainTip.slice(0, 8)}`);
      } catch (err) {
        console.error(`  Failed to rebase ${kid.slice(0, 8)}: ${err?.stderr?.toString()?.slice(0, 60) || ''}`);
      }
    }
  }

  if (rebased === 0) { console.log('Nothing to rebase.'); return; }

  // Renumber
  const freshEntries = loadEntries(base);
  const freshGroups = groupEntries(freshEntries, meta).filter(g => g.bookmark && meta.bookmarks?.[g.bookmark]);
  const prefix = config.prefix || 'TP';
  const doneIndexes = Object.values(meta.done || {}).map(d => parseInt(d.tpIndex?.replace(/\D/g, '')) || 0);
  let idx = doneIndexes.length > 0 ? Math.max(...doneIndexes) + 1 : 1;
  for (const g of freshGroups) {
    const bm = meta.bookmarks[g.bookmark];
    if (!bm) continue;
    const newTp = `${prefix}-${idx}`;
    bm.tpIndex = newTp;
    bm.prTitle = `${newTp}: ${bm.wiTitle}`;
    idx++;
  }
  meta.nextIndex = idx;
  saveMeta(meta);

  // Check conflicts
  const conflictIds = (jjSafe(`log --no-graph -r 'conflicts()' -T 'change_id.short() ++ "\\n"'`) || '').split('\n').filter(Boolean);
  if (conflictIds.length > 0) {
    console.log(`\n⚠ ${conflictIds.length} conflict(s) after linearize. Resolve with: jj resolve -r <changeId>`);
  } else {
    console.log(`\nDone — ${rebased} branch(es) linearized. No conflicts.`);
  }
}

// ── vpr log ───────────────────────────────────────────────────────────
export function cmdLog(args) {
  requireJj();
  const meta = loadMeta();
  const base = getBase() || 'main';

  const C = '\x1b[36m';   // cyan
  const G = '\x1b[32m';   // green
  const Y = '\x1b[33m';   // yellow
  const R = '\x1b[0m';    // reset
  const D = '\x1b[2m';    // dim
  const B = '\x1b[1m';    // bold
  const RED = '\x1b[31m';

  // Use jj log with a custom template showing VPR info
  const template = [
    'if(bookmarks, ',
    '  if(conflict, "' + RED + '! " , "  ") ',
    '  ++ surround("' + C + B + '", "' + R + '", ',
    '    bookmarks.map(|b| b.name()).join(" ") ',
    '  ) ',
    '  ++ " " ++ description.first_line() ',
    ',',
    '  if(conflict, "' + RED + '! " , "  ") ',
    '  ++ change_id.short() ++ " " ++ description.first_line()',
    ')',
  ].join('');

  const limit = args.find(a => /^\d+$/.test(a)) || '30';

  try {
    const output = jj(`log --limit ${limit} -r '${base}..(visible_heads() & descendants(${base}))' -T '${template.replace(/'/g, "'\\''")}'`);
    console.log(output);
  } catch {
    // Fallback to simpler template
    try {
      const output = jj(`log --limit ${limit} -r '${base}..(visible_heads() & descendants(${base}))'`);
      console.log(output);
    } catch (err) {
      console.error('Failed to show log:', err?.stderr?.toString()?.slice(0, 100) || '');
    }
  }
}

// ── vpr sort [--dry-run] ──────────────────────────────────────────────
export async function cmdSort(args) {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base, { files: true });
  const groups = groupEntries(entries, meta);
  const dryRun = args.includes('--dry-run');

  // Only analyze groups with bookmarks (skip ungrouped)
  const activeGroups = groups.filter(g => g.bookmark && meta.bookmarks?.[g.bookmark]);
  if (activeGroups.length < 2) { console.log('Nothing to sort (< 2 groups)'); return; }

  // Load root package.json deps to exclude common packages
  const rootPkgs = new Set();
  try {
    const rootPkg = JSON.parse(jjSafe(`file show -r ${base} package.json`) || '{}');
    for (const section of ['dependencies', 'devDependencies']) {
      for (const pkg of Object.keys(rootPkg[section] || {})) rootPkgs.add(pkg);
    }
  } catch {}

  // Collect what each group adds
  const fileOrigin = new Map();  // file path → group index
  const pkgOrigin = new Map();   // npm package → group index

  for (let i = 0; i < activeGroups.length; i++) {
    const g = activeGroups[i];
    for (const commit of g.commits) {
      for (const file of (commit.files || [])) {
        if (file.startsWith('A ')) fileOrigin.set(file.slice(2).trim(), i);
      }
      // Check package.json additions
      const hasPackageJson = (commit.files || []).some(f => f.includes('package.json'));
      if (hasPackageJson) {
        try {
          const diff = getDiffForCommit(commit.changeId || commit.sha);
          for (const line of diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              // Match dependency lines: "package-name": "^1.0.0" (must have semver-like value)
              const pkgMatch = line.match(/"(@?[a-z][a-z0-9._-]*(?:\/[a-z][a-z0-9._-]*)?)"\s*:\s*"[\^~>=<*]/);
              if (pkgMatch && !rootPkgs.has(pkgMatch[1])) pkgOrigin.set(pkgMatch[1], i);
            }
          }
        } catch {}
      }
    }
  }

  // Find ordering issues: group at position i references something added by group at position j where j > i
  const issues = [];
  for (let i = 0; i < activeGroups.length; i++) {
    const g = activeGroups[i];
    for (const commit of g.commits) {
      let diff;
      try { diff = getDiffForCommit(commit.changeId || commit.sha); } catch { continue; }

      // Check file references
      for (const [file, originIdx] of fileOrigin) {
        // Match on full path or import-style path (e.g. from './components/AudioPlayer' or '@transit/ui/StepFlow')
        const importPath = file.replace(/\.(tsx?|jsx?|css)$/, '');  // strip extension for import matching
        if (originIdx !== i && originIdx > i && (diff.includes(file) || diff.includes(importPath))) {
          const originGroup = activeGroups[originIdx];
          const originMeta = meta.bookmarks[originGroup.bookmark] || {};
          const thisMeta = meta.bookmarks[g.bookmark] || {};
          issues.push({
            depGroup: originIdx,
            depTp: originMeta.tpIndex || originGroup.bookmark,
            depTitle: originMeta.wiTitle || '',
            consumerGroup: i,
            consumerTp: thisMeta.tpIndex || g.bookmark,
            reason: `uses ${file} (added by ${originMeta.tpIndex || originGroup.bookmark})`,
          });
        }
      }

      // Check package references — only match actual import/require statements
      for (const [pkg, originIdx] of pkgOrigin) {
        const importPattern = new RegExp(`(from\\s+['"]${pkg.replace('/', '\\/')}|require\\(['"]${pkg.replace('/', '\\/')}|@import\\s+["']${pkg.replace('/', '\\/')})`);
        if (originIdx !== i && originIdx > i && importPattern.test(diff)) {
          const originGroup = activeGroups[originIdx];
          const originMeta = meta.bookmarks[originGroup.bookmark] || {};
          const thisMeta = meta.bookmarks[g.bookmark] || {};
          issues.push({
            depGroup: originIdx,
            depTp: originMeta.tpIndex || originGroup.bookmark,
            depTitle: originMeta.wiTitle || '',
            consumerGroup: i,
            consumerTp: thisMeta.tpIndex || g.bookmark,
            reason: `imports ${pkg} (added by ${originMeta.tpIndex || originGroup.bookmark})`,
          });
        }
      }
    }
  }

  // Deduplicate issues by depGroup
  const seen = new Set();
  const uniqueIssues = issues.filter(issue => {
    const key = `${issue.depGroup}->${issue.consumerGroup}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueIssues.length === 0) {
    console.log('Chain order is correct — no dependency issues found.');
    return;
  }

  // Show issues
  console.log(`\nDependency analysis found ${uniqueIssues.length} ordering issue(s):\n`);
  for (const issue of uniqueIssues) {
    const targetPos = issue.consumerGroup;
    console.log(`  ${issue.depTp}: ${issue.depTitle}`);
    console.log(`    → move before ${issue.consumerTp} (position ${targetPos + 1})`);
    console.log(`    reason: ${issue.reason}`);
    console.log('');
  }
  console.log('Indexes will be renumbered after reordering.\n');

  if (dryRun) {
    console.log('Dry run — no changes made.');
    return;
  }

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question('Apply? (y/n) ', r));
  rl.close();
  if (answer !== 'y') { console.log('Cancelled.'); return; }

  // Execute: for each issue, rebase the dependency group's commits before the consumer
  // Process unique dep groups, sorted by target position (earliest first)
  const moveOps = [...new Map(uniqueIssues.map(i => [i.depGroup, i])).values()]
    .sort((a, b) => a.consumerGroup - b.consumerGroup);

  for (const op of moveOps) {
    const depGroup = activeGroups[op.depGroup];
    const consumerGroup = activeGroups[op.consumerGroup];
    const firstConsumerCommit = consumerGroup.commits[0];
    if (!firstConsumerCommit) continue;

    // Rebase all commits in the dep group before the first consumer commit
    for (const commit of depGroup.commits) {
      try {
        jj(`rebase -r ${commit.changeId} -B ${firstConsumerCommit.changeId}`);
      } catch (err) {
        console.error(`  Failed to rebase ${commit.changeId?.slice(0, 8)}: ${err?.stderr?.toString()?.slice(0, 60) || ''}`);
      }
    }
    console.log(`  Moved ${op.depTp} before ${op.consumerTp}`);
  }

  // Renumber indexes
  const freshEntries = loadEntries(base, { files: true });
  const freshGroups = groupEntries(freshEntries, meta).filter(g => g.bookmark && meta.bookmarks?.[g.bookmark]);
  const prefix = config.prefix || 'TP';
  let idx = 1;

  // Find the starting index from done items
  const doneIndexes = Object.values(meta.done || {}).map(d => parseInt(d.tpIndex?.replace(/\D/g, '')) || 0);
  if (doneIndexes.length > 0) idx = Math.max(...doneIndexes) + 1;

  for (const g of freshGroups) {
    const bm = meta.bookmarks[g.bookmark];
    if (!bm) continue;
    const newTp = `${prefix}-${idx}`;
    const oldTp = bm.tpIndex;
    if (oldTp !== newTp) {
      bm.tpIndex = newTp;
      bm.prTitle = bm.prTitle?.replace(oldTp, newTp) || `${newTp}: ${bm.wiTitle}`;
      console.log(`  ${oldTp} → ${newTp}`);
    }
    idx++;
  }
  meta.nextIndex = idx;
  saveMeta(meta);

  console.log('\nDone. Run `vpr status` to verify.');
}

// ── Helpers ────────────────────────────────────────────────────────────
function validateChainOrder(groups, meta, base) {
  const errors = [];
  const resolvedBase = resolveToBookmark(base);

  // Build a set of known bookmark names for lookup
  const knownBookmarks = new Set(groups.filter(g => g.bookmark).map(g => g.bookmark));

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.bookmark) continue;
    const m = meta.bookmarks?.[g.bookmark] || {};
    const target = i > 0 ? groups[i - 1].bookmark : resolvedBase;
    if (!target) continue;

    // Ask jj for all commits between target and this bookmark
    const raw = jjSafe(`log --no-graph -r '${target}..${g.bookmark}' -T 'change_id.short() ++ "\\t" ++ bookmarks ++ "\\n"'`);
    if (!raw) continue;

    const groupChangeIds = new Set(g.commits.map(c => c.changeId.slice(0, 8)));
    for (const line of raw.split('\n')) {
      if (!line.includes('\t')) continue;
      const [cid, bms] = line.split('\t');
      const changeId = cid?.trim();
      if (!changeId) continue;

      // Check if this commit belongs to a different group
      const commitBookmarks = bms?.trim().split(/\s+/).filter(Boolean) || [];
      const foreignBookmark = commitBookmarks.find(b => knownBookmarks.has(b) && b !== g.bookmark);

      if (!groupChangeIds.has(changeId.slice(0, 8)) && !foreignBookmark) {
        // Ungrouped commit in the range — could be fine, skip
        continue;
      }
      if (foreignBookmark) {
        const foreignMeta = meta.bookmarks?.[foreignBookmark] || {};
        errors.push(
          `${m.tpIndex || g.bookmark}: contains commits from ${foreignMeta.tpIndex || foreignBookmark}`
        );
        break; // one error per group is enough
      }
    }
  }
  return errors;
}

function getGroupCommits(entries, bookmark, meta) {
  // Find commits belonging to this bookmark's group
  const result = [];
  let inGroup = false;
  for (const entry of entries) {
    if (entry.bookmark === bookmark) {
      result.push(entry);
      inGroup = false; // bookmark is the tip, stop
    } else if (entry.bookmark && entry.bookmark !== bookmark && meta.bookmarks?.[entry.bookmark]) {
      // Hit another bookmark — if we were collecting, stop
      if (inGroup) break;
      inGroup = true; // start collecting for next group
    } else if (inGroup || !entry.bookmark) {
      // Collect commits between bookmarks
    }
  }
  // Simpler: just collect pending commits until we hit the bookmark
  const simple = [];
  let pend = [];
  for (const entry of entries) {
    if (entry.bookmark === bookmark) {
      simple.push(...pend, entry);
      break;
    } else if (entry.bookmark && meta.bookmarks?.[entry.bookmark]) {
      pend = []; // reset — new group started
    } else {
      pend.push(entry);
    }
  }
  return simple;
}
