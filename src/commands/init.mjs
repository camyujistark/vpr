/**
 * vpr init — interactive setup for a project.
 * Creates .vpr/config.json with provider settings.
 */

import readline from 'readline';
import { loadConfig, saveConfig, PROVIDERS, configDirPath } from '../config.mjs';
import fs from 'fs';

function prompt(rl, question, defaultVal = '') {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function choose(rl, question, options) {
  return new Promise(resolve => {
    console.log(`\n${question}`);
    options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
    rl.question('> ', answer => {
      const idx = parseInt(answer) - 1;
      resolve(idx >= 0 && idx < options.length ? options[idx] : options[0]);
    });
  });
}

export async function init() {
  const existing = loadConfig();
  if (existing) {
    console.log(`VPR already initialized (provider: ${existing.provider}, prefix: ${existing.prefix})`);
    console.log(`Config: ${configDirPath()}/config.json`);
    console.log('Delete .vpr/ to reinitialize.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  VPR Init — Configure virtual PR management for this project\n');

  // Provider
  const providerNames = Object.keys(PROVIDERS);
  const provider = await choose(rl, 'Which provider?', providerNames);
  const template = { ...PROVIDERS[provider] };

  // Prefix
  template.prefix = await prompt(rl, 'VPR prefix (e.g. TP, FE, BE)', template.prefix);

  // Provider-specific settings
  if (provider === 'azure-devops') {
    template.org = await prompt(rl, 'Organization URL', template.org || 'https://dev.azure.com/YourOrg');
    template.project = await prompt(rl, 'Project name', template.project);
    template.repo = await prompt(rl, 'Repository name', template.repo);
    template.wiType = await prompt(rl, 'Work item type', template.wiType || 'Task');
  } else if (provider === 'github') {
    // Try to auto-detect from git remote
    let defaultRepo = '';
    try {
      const remote = fs.readFileSync('.git/config', 'utf-8');
      const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
      if (match) defaultRepo = match[1];
    } catch {}
    template.repo = await prompt(rl, 'Repository (owner/repo)', defaultRepo);
  } else if (provider === 'bitbucket') {
    template.workspace = await prompt(rl, 'Workspace', template.workspace);
    template.repo = await prompt(rl, 'Repository slug', template.repo);
  } else if (provider === 'gitlab') {
    template.repo = await prompt(rl, 'Project path', template.repo);
  }

  rl.close();

  // Save
  saveConfig(template);

  // Add .vpr/ to .gitignore if not already there
  const gitignorePath = '.gitignore';
  try {
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (!gitignore.includes('.vpr/')) {
      fs.appendFileSync(gitignorePath, '\n# VPR metadata\n.vpr/\n');
      console.log('Added .vpr/ to .gitignore');
    }
  } catch {}

  console.log(`\nInitialized VPR with ${provider} provider (prefix: ${template.prefix})`);
  console.log(`Config saved to .vpr/config.json`);
  console.log(`\nNext: make commits and run \`vpr\` to manage virtual PRs`);
  process.exit(0);
}
