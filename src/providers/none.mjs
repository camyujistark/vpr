/**
 * No-op provider — for projects that don't use a remote tracker.
 * VPRs still work for local commit grouping and branch rendering.
 */

import { BaseProvider } from './base.mjs';

export class NoneProvider extends BaseProvider {
  get name() { return 'local (no provider)'; }

  createWorkItem(title) {
    const id = Date.now();
    return { id, url: null };
  }

  getWorkItem(id) {
    return { id, title: '', description: '', state: 'local', url: null };
  }

  updateWorkItem() {}
  createPR() { return { id: null, url: null }; }
}
