import { parse } from '../core/plan.mjs';
import { jj, jjSafe } from '../core/jj.mjs';

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function makeBookmarkName(epicWi, taskTitle, prTitle) {
  const parts = [];
  if (epicWi) parts.push(String(epicWi));
  parts.push(slugify(taskTitle));
  parts.push(slugify(prTitle));
  return `feat/${parts.join('-')}`;
}

function buildPrBody(pr, task) {
  const parts = [pr.description.trim()];
  if (task.wi) parts.push(`Closes AB#${task.wi}`);
  return parts.filter(Boolean).join('\n\n');
}

const defaultJjApi = {
  resolveLastCommit(range) {
    const out = jjSafe(`log -r '${range}' --no-graph --template 'commit_id.short()' -n 1`);
    return out ? out.trim() : null;
  },
  setBookmark(name, commit) {
    jj(`bookmark set ${name} -r ${commit} --allow-backwards`);
  },
  pushBookmark(name) {
    jj(`git push --bookmark ${name}`);
  },
};

export function ship({
  planPath = 'plan.md',
  dryRun = false,
  provider = null,
  jjApi = defaultJjApi,
} = {}) {
  const plan = parse(planPath);
  const results = [];
  const priorBookmarks = new Map(); // PR title → bookmark name

  for (const task of plan.tasks) {
    for (const pr of task.prs) {
      const result = {
        title: pr.title,
        task: task.title,
        commits: pr.commits,
        status: null,
        bookmark: null,
        target: null,
        prId: null,
      };

      if (!pr.commits.trim()) {
        result.status = 'no-commits';
        results.push(result);
        continue;
      }

      const lastCommit = jjApi.resolveLastCommit(pr.commits);
      if (!lastCommit) {
        result.status = 'no-commits';
        results.push(result);
        continue;
      }
      result.commit = lastCommit;

      const bookmark = makeBookmarkName(plan.epic.wi, task.title, pr.title);
      result.bookmark = bookmark;

      const target = pr.targets === 'main'
        ? 'main'
        : (priorBookmarks.get(pr.targets) || pr.targets);
      result.target = target;

      if (dryRun) {
        result.status = 'dry';
        results.push(result);
        priorBookmarks.set(pr.title, bookmark);
        continue;
      }

      jjApi.setBookmark(bookmark, lastCommit);
      jjApi.pushBookmark(bookmark);

      if (provider) {
        try {
          const prResult = provider.createPR({
            branch: bookmark,
            base: target,
            title: pr.title,
            body: buildPrBody(pr, task),
            taskWi: task.wi,
          });
          result.prId = prResult?.id ?? null;
          result.status = 'shipped';
        } catch (err) {
          result.status = 'error';
          result.error = err.message;
        }
      } else {
        result.status = 'pushed';
      }

      results.push(result);
      priorBookmarks.set(pr.title, bookmark);
    }
  }

  return results;
}
