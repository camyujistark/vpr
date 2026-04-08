/**
 * Azure DevOps provider — work items via `az boards`, PRs via `az repos`.
 */

import { execSync } from 'child_process';
import { BaseProvider } from './base.mjs';
import { getBaseBranch } from '../core/jj.mjs';

function az(cmd) {
  return JSON.parse(
    execSync(`az ${cmd} --output json`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
}

export class AzureDevOpsProvider extends BaseProvider {
  get name() { return 'Azure DevOps'; }

  get org() { return this.config.org; }
  get project() { return this.config.project; }
  get repo() { return this.config.repo; }
  get wiType() { return this.config.wiType || 'Task'; }

  createWorkItem(title, description = '') {
    const desc = description.replace(/"/g, '\\"');
    const result = az(
      `boards work-item create --type "${this.wiType}" --title "${title.replace(/"/g, '\\"')}"` +
      (desc ? ` --description "${desc}"` : '') +
      ` --project "${this.project}" --organization "${this.org}"`
    );
    return { id: result.id, url: result.url };
  }

  getWorkItem(id) {
    const result = az(
      `boards work-item show --id ${id} --org "${this.org}"`
    );
    const f = result.fields || {};
    return {
      id: result.id,
      title: f['System.Title'] || '',
      description: (f['System.Description'] || '').replace(/<[^>]*>/g, '').trim(),
      state: f['System.State'] || '',
      url: result.url,
    };
  }

  updateWorkItem(id, fields) {
    const args = [];
    if (fields.title) args.push(`--title "${fields.title.replace(/"/g, '\\"')}"`);
    if (fields.state) args.push(`--state "${fields.state}"`);
    if (fields.description) args.push(`--description "${fields.description.replace(/"/g, '\\"')}"`);
    if (args.length === 0) return;
    az(`boards work-item update --id ${id} ${args.join(' ')} --org "${this.org}"`);
  }

  createPR(sourceBranch, targetBranch, title, body, workItemId) {
    const wiFlag = workItemId ? ` --work-items ${workItemId}` : '';
    const result = az(
      `repos pr create --repository "${this.repo}"` +
      ` --source-branch "${sourceBranch}" --target-branch "${targetBranch}"` +
      ` --title "${title.replace(/"/g, '\\"')}"` +
      ` --description "${(body || '').replace(/"/g, '\\"')}"` +
      `${wiFlag}` +
      ` --project "${this.project}" --organization "${this.org}"`
    );
    return { id: result.pullRequestId, url: result.url };
  }

  getLatestPRIndex() {
    try {
      const prs = this._listActivePRs(5);
      if (prs.length === 0) return 0;
      let max = 0;
      for (const pr of prs) {
        // Match "PREFIX-123" when prefix set, or "123 - " when no prefix
        const pattern = this.config.prefix
          ? new RegExp(`${this.config.prefix}-(\\d+)`)
          : /^(\d+)[:\s-]/;
        const match = pr.title?.match(pattern);
        if (match) max = Math.max(max, parseInt(match[1]));
      }
      return max;
    } catch { return 0; }
  }

  getChainTop() {
    try {
      const prs = this._listActivePRs(1);
      if (prs.length === 0) return getBaseBranch() ?? 'main';
      return prs[0].sourceRefName?.replace('refs/heads/', '') || getBaseBranch() || 'main';
    } catch { return getBaseBranch() ?? 'main'; }
  }

  _listActivePRs(top = 5) {
    return az(
      `repos pr list --repository "${this.repo}" --status active --top ${top}` +
      ` --project "${this.project}" --organization "${this.org}"`
    );
  }
}
