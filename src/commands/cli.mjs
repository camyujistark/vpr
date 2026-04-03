/**
 * VPR CLI commands — scriptable interface for AI and automation.
 * Each function is a self-contained command that reads config/meta, does work, outputs JSON.
 */

import { execSync } from 'child_process';
import readline from 'readline';
import { loadConfig, loadMeta, saveMeta } from '../config.mjs';
import { jj, jjSafe, hasJj, getBase } from '../git.mjs';
import { createProvider } from '../providers/index.mjs';

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
  const entries = loadEntries(base);

  // Group entries
  const groups = [];
  let pending = [];
  for (const entry of entries) {
    if (entry.bookmark) {
      groups.push({ bookmark: entry.bookmark, commits: [...pending, entry] });
      pending = [];
    } else {
      pending.push(entry);
    }
  }
  if (pending.length > 0) groups.push({ bookmark: null, commits: pending });

  // Sort by TP index
  groups.sort((a, b) => {
    if (!a.bookmark) return 1;
    if (!b.bookmark) return -1;
    const aMeta = meta.bookmarks?.[a.bookmark] || {};
    const bMeta = meta.bookmarks?.[b.bookmark] || {};
    const aNum = parseInt(aMeta.tpIndex?.replace(/\D/g, '')) || parseInt(a.bookmark.replace(/\D/g, '')) || 0;
    const bNum = parseInt(bMeta.tpIndex?.replace(/\D/g, '')) || parseInt(b.bookmark.replace(/\D/g, '')) || 0;
    return aNum - bNum;
  });

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
      target: prevGroup?.bookmark || base,
      commits: g.commits.map(c => ({
        changeId: c.changeId,
        sha: c.sha,
        subject: c.subject,
      })),
    };
  });

  console.log(JSON.stringify(result, null, 2));
}

// ── vpr status ─────────────────────────────────────────────────────────
export function cmdStatus() {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base);

  const groups = [];
  let pending = [];
  for (const entry of entries) {
    if (entry.bookmark) {
      groups.push({ bookmark: entry.bookmark, commits: [...pending, entry] });
      pending = [];
    } else {
      pending.push(entry);
    }
  }
  if (pending.length > 0) groups.push({ bookmark: null, commits: pending });

  groups.sort((a, b) => {
    if (!a.bookmark) return 1;
    if (!b.bookmark) return -1;
    const aMeta = meta.bookmarks?.[a.bookmark] || {};
    const bMeta = meta.bookmarks?.[b.bookmark] || {};
    const aNum = parseInt(aMeta.tpIndex?.replace(/\D/g, '')) || 0;
    const bNum = parseInt(bMeta.tpIndex?.replace(/\D/g, '')) || 0;
    return aNum - bNum;
  });

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const bmMeta = g.bookmark ? (meta.bookmarks?.[g.bookmark] || {}) : {};
    const target = i > 0 ? groups[i - 1].bookmark : base;
    const tp = bmMeta.tpIndex || '';
    const title = bmMeta.wiTitle || g.bookmark || 'ungrouped';
    const wi = bmMeta.wi ? `#${bmMeta.wi}` : '';

    console.log(`${tp} ${wi} ${title}`);
    console.log(`  branch: ${g.bookmark || '(none)'}`);
    console.log(`  target: ${target}`);
    console.log(`  commits: ${g.commits.length}`);
    for (const c of g.commits) {
      console.log(`    ${c.changeId.slice(0, 8)} ${c.subject}`);
    }
    console.log('');
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

// ── vpr send [--dry-run] ───────────────────────────────────────────────
export async function cmdSend(args) {
  requireJj();
  const config = requireConfig();
  const meta = loadMeta();
  const base = getBase() || 'main';
  const entries = loadEntries(base);
  const dryRun = args.includes('--dry-run');

  const groups = [];
  let pending = [];
  for (const entry of entries) {
    if (entry.bookmark) {
      groups.push({ bookmark: entry.bookmark, commits: [...pending, entry] });
      pending = [];
    } else {
      pending.push(entry);
    }
  }

  // Sort by TP index
  groups.sort((a, b) => {
    if (!a.bookmark) return 1;
    if (!b.bookmark) return -1;
    const aMeta = meta.bookmarks?.[a.bookmark] || {};
    const bMeta = meta.bookmarks?.[b.bookmark] || {};
    const aNum = parseInt(aMeta.tpIndex?.replace(/\D/g, '')) || 0;
    const bNum = parseInt(bMeta.tpIndex?.replace(/\D/g, '')) || 0;
    return aNum - bNum;
  });

  if (groups.length === 0) { console.log('No groups to send'); return; }

  // Validation
  let hasErrors = false;
  for (const g of groups) {
    if (!g.bookmark) continue;
    const m = meta.bookmarks?.[g.bookmark] || {};
    if (!m.prTitle) { console.error(`Missing PR title for ${m.tpIndex || g.bookmark}`); hasErrors = true; }
    if (!m.wi) { console.error(`Missing work item for ${m.tpIndex || g.bookmark}`); hasErrors = true; }
  }
  if (hasErrors && !dryRun) { console.error('\nFix missing fields before sending.'); process.exit(1); }

  // Show chain
  console.log(`\n=== ${dryRun ? 'DRY RUN' : 'SEND'}: ${groups.filter(g => g.bookmark).length} PRs ===\n`);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.bookmark) continue;
    const m = meta.bookmarks?.[g.bookmark] || {};
    const target = i > 0 ? groups[i - 1]?.bookmark : base;

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

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.bookmark) continue;
    const m = meta.bookmarks?.[g.bookmark] || {};
    const target = i > 0 ? groups[i - 1]?.bookmark : base;

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

    // Create PR
    const prTitle = (m.prTitle || '').replace(/"/g, '\\"');
    const prDesc = (m.prDesc || '').replace(/"/g, '\\"');
    try {
      const result = execSync(
        `az repos pr create --repository "${config.repo}" ` +
        `--source-branch "${g.bookmark}" --target-branch "${target}" ` +
        `--title "${prTitle}" ` +
        `--description "${prDesc}" ` +
        (m.wi ? `--work-items ${m.wi} ` : '') +
        `--project "${config.project}" --organization "${config.org}" --output json`,
        { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const prData = JSON.parse(result);
      console.log(`  PR created: #${prData.pullRequestId}`);

      // Update WI to Done
      if (m.wi) {
        try {
          execSync(
            `az boards work-item update --id ${m.wi} --state Done --org "${config.org}" --output json`,
            { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }
          );
          console.log(`  WI #${m.wi} → Done`);
        } catch {}
      }
    } catch (err) {
      console.error(`  Failed to create PR: ${err?.stderr?.toString()?.slice(0, 100) || err.message}`);
    }
  }

  rl.close();
  console.log('\nDone.');
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
function findBookmark(meta, query) {
  if (!query) return null;
  // Exact match
  if (meta.bookmarks?.[query]) return query;
  // Match by TP index (e.g. "tp-91" or "TP-91")
  const lower = query.toLowerCase();
  for (const [bm, m] of Object.entries(meta.bookmarks || {})) {
    if (m.tpIndex?.toLowerCase() === lower) return bm;
    if (bm.toLowerCase() === lower) return bm;
  }
  // Partial match
  for (const [bm, m] of Object.entries(meta.bookmarks || {})) {
    if (bm.includes(query)) return bm;
  }
  return null;
}

function loadEntries(base) {
  const raw = jjSafe(`log --no-graph --reversed -r '${base}..@-' -T 'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"'`);
  if (!raw) return [];
  const meta = loadMeta();
  return raw.split('\n').filter(Boolean).map(line => {
    const [changeId, sha, bookmarkStr, subject] = line.split('\t');
    const allBookmarks = bookmarkStr?.trim().split(/\s+/).filter(Boolean) || [];
    const bookmark = allBookmarks.find(b => meta.bookmarks?.[b]) || null;
    return { changeId: changeId?.trim(), sha: sha?.trim(), subject: subject?.trim(), bookmark };
  });
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
