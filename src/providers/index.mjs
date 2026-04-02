/**
 * Provider factory — returns the right provider instance based on config.
 */

import { AzureDevOpsProvider } from './azure-devops.mjs';
import { GitHubProvider } from './github.mjs';
import { NoneProvider } from './none.mjs';

const PROVIDERS = {
  'azure-devops': AzureDevOpsProvider,
  'github': GitHubProvider,
  'none': NoneProvider,
};

export function createProvider(config) {
  const Provider = PROVIDERS[config.provider];
  if (!Provider) throw new Error(`Unknown provider: ${config.provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return new Provider(config);
}
