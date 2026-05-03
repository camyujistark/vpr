import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AzureDevOpsProvider, TERMINAL_STATES } from '../../src/providers/azure-devops.mjs';

describe('AzureDevOpsProvider.updateWorkItemDescription()', () => {
  it('invokes az boards work-item update with id, description, and org', () => {
    const provider = new AzureDevOpsProvider({
      org: 'https://dev.azure.com/example',
      project: 'p',
      repo: 'r',
    });
    let captured = null;
    provider._az = (cmd) => { captured = cmd; return {}; };

    provider.updateWorkItemDescription(42, 'new body');

    assert.ok(captured, 'should invoke _az');
    assert.match(captured, /^boards work-item update /);
    assert.match(captured, /--id 42\b/);
    assert.match(captured, /--description 'new body'/);
    assert.match(captured, /--org 'https:\/\/dev\.azure\.com\/example'/);
  });

  it('escapes embedded double quotes in the description body', () => {
    const provider = new AzureDevOpsProvider({
      org: 'https://dev.azure.com/example',
      project: 'p',
      repo: 'r',
    });
    let captured = null;
    provider._az = (cmd) => { captured = cmd; return {}; };

    provider.updateWorkItemDescription(7, "has 'quotes'");

    assert.match(captured, /--description 'has '\\''quotes'\\''/);
  });
});

describe('TERMINAL_STATES', () => {
  it('AC12: exports the four terminal WI states', () => {
    assert.ok(Array.isArray(TERMINAL_STATES));
    assert.ok(TERMINAL_STATES.includes('Done'));
    assert.ok(TERMINAL_STATES.includes('Closed'));
    assert.ok(TERMINAL_STATES.includes('Resolved'));
    assert.ok(TERMINAL_STATES.includes('Removed'));
  });
});

describe('AzureDevOpsProvider.getPRStatus()', () => {
  it('AC11: returns merged true and mergedAt from completionQueueTime when status is completed', () => {
    const provider = new AzureDevOpsProvider({ org: 'https://dev.azure.com/ex', project: 'p', repo: 'r' });
    let captured = null;
    const MERGED_AT = '2025-01-15T12:00:00Z';
    provider._az = (cmd) => {
      captured = cmd;
      return { status: 'completed', completionQueueTime: MERGED_AT };
    };

    const result = provider.getPRStatus(99);

    assert.match(captured, /repos pr show --id 99\b/);
    assert.strictEqual(result.merged, true);
    assert.strictEqual(result.mergedAt, MERGED_AT);
  });

  it('AC11: returns merged false when PR is not completed', () => {
    const provider = new AzureDevOpsProvider({ org: 'https://dev.azure.com/ex', project: 'p', repo: 'r' });
    provider._az = () => ({ status: 'active', completionQueueTime: null });

    const result = provider.getPRStatus(7);

    assert.strictEqual(result.merged, false);
    assert.strictEqual(result.mergedAt, null);
  });
});
