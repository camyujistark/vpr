/**
 * Azure DevOps provider — work items via `az boards`, PRs via `az repos`.
 */

import { execSync } from 'child_process';
import { BaseProvider } from './base.mjs';

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

  async createWorkItem(title, description = '') {
    const desc = description.replace(/"/g, '\\"');
    const result = az(
      `boards work-item create --type "${this.wiType}" --title "${title.replace(/"/g, '\\"')}"` +
      (desc ? ` --description "${desc}"` : '') +
      ` --project "${this.project}" --organization "${this.org}"`
    );
    return { id: result.id, url: result.url };
  }

  async getWorkItem(id) {
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

  async updateWorkItem(id, fields) {
    const args = [];
    if (fields.title) args.push(`--title "${fields.title.replace(/"/g, '\\"')}"`);
    if (fields.state) args.push(`--state "${fields.state}"`);
    if (fields.description) args.push(`--description "${fields.description.replace(/"/g, '\\"')}"`);
    if (args.length === 0) return;
    az(`boards work-item update --id ${id} ${args.join(' ')} --org "${this.org}"`);
  }

  async createPR(sourceBranch, targetBranch, title, body, workItemId) {
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

  async getLatestPRIndex() {
    try {
      const result = az(
        `repos pr list --repository "${this.repo}" --top 1` +
        ` --project "${this.project}" --organization "${this.org}"`
      );
      if (result.length === 0) return 0;
      // Extract TP-XX from the latest PR title
      const match = result[0].title?.match(new RegExp(`${this.config.prefix}-(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    } catch { return 0; }
  }
}
