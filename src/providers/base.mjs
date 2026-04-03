/**
 * Base provider — interface for work item and PR operations.
 * Each provider implements these methods.
 */

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

  /** Get the latest PR index (for sequential numbering) */
getLatestPRIndex() {
    return 0;
  }

  /** Provider display name */
  get name() {
    return 'base';
  }
}
