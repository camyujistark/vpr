/**
 * Azure DevOps provider — work items via `az boards`, PRs via `az repos`.
 */

export const TERMINAL_STATES = ['Done', 'Closed', 'Resolved', 'Removed'];

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Bash single-quote a value so backticks, $, !, etc. are literal.
 * Single quotes preserve everything except single quotes; embed those as '\''.
 */
function sq(value) {
  const s = String(value ?? '');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class AzureDevOpsProvider extends BaseProvider {
  get name() { return 'Azure DevOps'; }

  get org() { return this.config.org; }
  get project() { return this.config.project; }
  get repo() { return this.config.repo; }
  get wiType() { return this.config.wiType || 'Task'; }

  _az(cmd) { return az(cmd); }

  updateWorkItemDescription(id, body) {
    this._az(`boards work-item update --id ${id} --description ${sq(body)} --org ${sq(this.org)}`);
  }

  createWorkItem(title, description = '') {
    const result = az(
      `boards work-item create --type ${sq(this.wiType)} --title ${sq(title)}` +
      (description ? ` --description ${sq(description)}` : '') +
      ` --project ${sq(this.project)} --organization ${sq(this.org)}`
    );
    return { id: result.id, url: result.url };
  }

  linkParent(childId, parentId) {
    az(
      `boards work-item relation add --id ${childId} --relation-type Parent --target-id ${parentId} --org ${sq(this.org)}`
    );
  }

  assignTo(id, user) {
    az(`boards work-item update --id ${id} --assigned-to ${sq(user)} --org ${sq(this.org)}`);
  }

  getWorkItem(id) {
    const result = az(
      `boards work-item show --id ${id} --org ${sq(this.org)}`
    );
    const f = result.fields || {};
    const assigned = f['System.AssignedTo'];
    return {
      id: result.id,
      type: f['System.WorkItemType'] || '',
      title: f['System.Title'] || '',
      description: (f['System.Description'] || '').replace(/<[^>]*>/g, '').trim(),
      state: f['System.State'] || '',
      assignedTo: assigned ? (assigned.uniqueName || assigned.displayName || null) : null,
      url: result.url,
    };
  }

  getCurrentUser() {
    try {
      const out = execSync('az account show --query "user.name" -o tsv', {
        encoding: 'utf-8',
        shell: '/bin/bash',
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  getChildren(id) {
    const result = az(
      `boards work-item show --id ${id} --expand relations --org ${sq(this.org)}`
    );
    const rels = result.relations || [];
    const childIds = rels
      .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(r => {
        const m = (r.url || '').match(/\/workItems\/(\d+)$/i);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(Boolean);
    return childIds.map(cid => this.getWorkItem(cid));
  }

  updateWorkItem(id, fields) {
    const args = [];
    if (fields.title) args.push(`--title ${sq(fields.title)}`);
    if (fields.state) args.push(`--state ${sq(fields.state)}`);
    if (fields.description) args.push(`--description ${sq(fields.description)}`);
    if (args.length === 0) return;
    az(`boards work-item update --id ${id} ${args.join(' ')} --org ${sq(this.org)}`);
  }

  getPRStatus(prId) {
    const pr = this._az(
      `repos pr show --id ${prId}` +
      ` --repository ${sq(this.repo)}` +
      ` --project ${sq(this.project)} --organization ${sq(this.org)}`
    );
    const merged = pr.status === 'completed';
    return { merged, mergedAt: merged ? (pr.completionQueueTime ?? null) : null };
  }

  createPR(sourceBranch, targetBranch, title, body, workItemId) {
    const wiFlag = workItemId ? ` --work-items ${workItemId}` : '';
    const result = az(
      `repos pr create --repository ${sq(this.repo)}` +
      ` --source-branch ${sq(sourceBranch)} --target-branch ${sq(targetBranch)}` +
      ` --title ${sq(title)}` +
      ` --description ${sq(body || '')}` +
      `${wiFlag}` +
      ` --project ${sq(this.project)} --organization ${sq(this.org)}`
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
      `repos pr list --repository ${sq(this.repo)} --status active --top ${top}` +
      ` --project ${sq(this.project)} --organization ${sq(this.org)}`
    );
  }

  /**
   * Resolve the repository UUID from its name. Cached on the instance — the
   * `az devops invoke` calls below need the UUID, but the user-facing config
   * uses the human-readable repo name.
   */
  _getRepoId() {
    if (this._repoId) return this._repoId;
    const result = az(
      `repos show --repository ${sq(this.repo)}` +
      ` --project ${sq(this.project)} --organization ${sq(this.org)}`
    );
    this._repoId = result.id;
    return this._repoId;
  }

  /**
   * Post a comment to a PR as a new thread. Used after PR creation to attach
   * the QA checklist as a separate, tickable comment.
   */
  postPRComment(prId, content) {
    const repoId = this._getRepoId();
    const body = JSON.stringify({
      comments: [{ parentCommentId: 0, content: String(content ?? ''), commentType: 1 }],
      status: 1,
    });
    const tmpFile = join(tmpdir(), `vpr-pr-comment-${process.pid}-${Date.now()}.json`);
    writeFileSync(tmpFile, body);
    try {
      az(
        `devops invoke --area git --resource pullRequestThreads` +
        ` --route-parameters project=${sq(this.project)} repositoryId=${sq(repoId)} pullRequestId=${prId}` +
        ` --http-method POST --api-version 7.1 --in-file ${sq(tmpFile)}` +
        ` --org ${sq(this.org)}`
      );
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}
