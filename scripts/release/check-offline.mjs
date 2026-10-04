#!/usr/bin/env node

/**
 * Run the repository's no-network acceptance lane.  Every command here uses
 * only checked-in source and Node's standard library.  Keep this list small
 * and explicit so a release reviewer can see exactly what was exercised.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const node = process.execPath;
const steps = [
  ['platform scaffold', node, ['scripts/release/verify-platform-scaffold.mjs']],
  ['ability manifests', node, ['scripts/validate-abilities.mjs']],
  ['registry schema', node, ['--experimental-strip-types', 'scripts/validate-registry.ts']],
  ['core/sdk/cli/platform tests', node, ['--test', 'packages/core/test/core.test.js', 'packages/ability-sdk/test/sdk.test.mjs', 'packages/ability-cli/test/cli.test.mjs', 'packages/platform-adapters/test/platform-adapters.test.mjs']],
  ['registry-security tests', node, ['--experimental-strip-types', 'packages/registry-security/tests/registry-security.test.ts']],
  ['core smoke', node, ['scripts/smoke.mjs']],
  ['v0.2 lifecycle E2E', node, ['scripts/e2e-v02.mjs']],
  ['installer demo', node, ['--experimental-strip-types', 'scripts/demo-install.ts']],
  ['dashboard smoke', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'apps/dashboard', 'run', 'smoke']],
];

for (const [label, command, args] of steps) {
  console.log(`\n[offline] ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, PAB_OFFLINE_CHECK: '1' },
  });
  if (result.error) {
    console.error(`[offline] ${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[offline] ${label} failed with exit code ${result.status ?? 'signal'}`);
    process.exit(result.status || 1);
  }
}

console.log('\nOffline acceptance lane: PASS (no network or paid model provider used)');
