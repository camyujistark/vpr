/**
 * Base provider — interface for work item and PR operations.
 * Each provider implements these methods.
 */

import { getBaseBranch } from '../core/jj.mjs';

export class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  /** Create a work item / issue. Returns { id, url } */
createWorkItem(title, description) {
    throw new Error('Not implemented');
  }

  /** Fetch work item details. Returns { id, title, description, state, url } */
getWorkItem(id) {
    throw new Error('Not implemented');
  }

  /** Update work item. Returns updated item. */
updateWorkItem(id, fields) {
    throw new Error('Not implemented');
  }

  /** Create a pull request. Returns { id, url } */
createPR(sourceBranch, targetBranch, title, body, workItemId) {
    throw new Error('Not implemented');
  }

  /** Return child work items (Tasks under a PBI, etc). Default: none. */
  getChildren(id) {
    return [];
  }

  /** Get the latest PR index (for sequential numbering) */
getLatestPRIndex() {
    return 0;
  }

  /** Get the chain top — source branch of the latest active PR */
  getChainTop() {
    return getBaseBranch() ?? 'main';
  }

  /** Provider display name */
  get name() {
    return 'base';
  }
}
