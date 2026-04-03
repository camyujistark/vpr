/**
 * GitHub provider — issues via `gh issue`, PRs via `gh pr`.
 */

import { execSync } from 'child_process';
import { BaseProvider } from './base.mjs';

function gh(cmd) {
  return JSON.parse(
    execSync(`gh ${cmd} --json id,title,body,state,url,number`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
}

function ghRaw(cmd) {
  return execSync(`gh ${cmd}`, {
    encoding: 'utf-8',
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export class GitHubProvider extends BaseProvider {
  get name() { return 'GitHub'; }

  get repo() { return this.config.repo; }

createWorkItem(title, description = '') {
    const result = JSON.parse(ghRaw(
      `issue create --repo "${this.repo}" --title "${title.replace(/"/g, '\\"')}"` +
      (description ? ` --body "${description.replace(/"/g, '\\"')}"` : '') +
      ' --json number,url'
    ));
    return { id: result.number, url: result.url };
  }

getWorkItem(id) {
    const result = JSON.parse(ghRaw(
      `issue view ${id} --repo "${this.repo}" --json number,title,body,state,url`
    ));
    return {
      id: result.number,
      title: result.title,
      description: result.body || '',
      state: result.state,
      url: result.url,
    };
  }

updateWorkItem(id, fields) {
    const args = [];
    if (fields.title) args.push(`--title "${fields.title.replace(/"/g, '\\"')}"`);
    if (fields.description) args.push(`--body "${fields.description.replace(/"/g, '\\"')}"`);
    if (args.length > 0) {
      ghRaw(`issue edit ${id} --repo "${this.repo}" ${args.join(' ')}`);
    }
    if (fields.state === 'Closed') {
      ghRaw(`issue close ${id} --repo "${this.repo}"`);
    }
  }

createPR(sourceBranch, targetBranch, title, body, workItemId) {
    const closes = workItemId ? `\n\nCloses #${workItemId}` : '';
    const result = JSON.parse(ghRaw(
      `pr create --repo "${this.repo}"` +
      ` --head "${sourceBranch}" --base "${targetBranch}"` +
      ` --title "${title.replace(/"/g, '\\"')}"` +
      ` --body "${((body || '') + closes).replace(/"/g, '\\"')}"` +
      ' --json number,url'
    ));
    return { id: result.number, url: result.url };
  }

getLatestPRIndex() {
    try {
      const result = JSON.parse(ghRaw(
        `pr list --repo "${this.repo}" --limit 1 --json title`
      ));
      if (result.length === 0) return 0;
      const match = result[0].title?.match(new RegExp(`${this.config.prefix}-(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    } catch { return 0; }
  }
}
