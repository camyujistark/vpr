import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AzureDevOpsProvider } from '../../src/providers/azure-devops.mjs';

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
    assert.match(captured, /--description "new body"/);
    assert.match(captured, /--org "https:\/\/dev\.azure\.com\/example"/);
  });

  it('escapes embedded double quotes in the description body', () => {
    const provider = new AzureDevOpsProvider({
      org: 'https://dev.azure.com/example',
      project: 'p',
      repo: 'r',
    });
    let captured = null;
    provider._az = (cmd) => { captured = cmd; return {}; };

    provider.updateWorkItemDescription(7, 'has "quotes"');

    assert.match(captured, /--description "has \\"quotes\\""/);
  });
});
