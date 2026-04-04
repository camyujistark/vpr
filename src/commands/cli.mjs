/**
 * VPR CLI commands — scriptable interface for AI and automation.
 * Each function is a self-contained command that reads config/meta, does work, outputs JSON.
 */

import { execSync } from 'child_process';
import readline from 'readline';
import { loadConfig, loadMeta, saveMeta } from '../config.mjs';
import { jj, jjSafe, hasJj, getBase } from '../git.mjs';
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

  // Find target commit
  const target = args[2] || '@-';

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

  console.log(JSON.stringify({ groups: result, done }, null, 2));
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
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base);
  const groups = groupEntries(entries, meta);
  const dryRun = args.includes('--dry-run');
  const specificId = args.find(a => a !== '--dry-run');

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
      const prResult = provider.createPR(g.bookmark, target, m.prTitle || '', m.prDesc || '', m.wi);
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
