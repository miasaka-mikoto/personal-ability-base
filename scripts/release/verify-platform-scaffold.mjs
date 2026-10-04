#!/usr/bin/env node

/**
 * Verify the platform adapter entry points without a network, SDK, emulator,
 * or native build tool.  This is deliberately a contract check: it proves
 * that the Windows and Android shell scaffolds are present and internally
 * consistent, but it does not claim that an EXE/APK/AAB has been produced.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(relative) {
  const filename = path.join(root, relative);
  if (!fs.existsSync(filename)) throw new Error(`missing ${relative}`);
  return fs.readFileSync(filename, 'utf8');
}

function json(relative) {
  try {
    return JSON.parse(read(relative));
  } catch (error) {
    throw new Error(`${relative}: invalid JSON (${error.message})`);
  }
}

const required = [
  'platform/windows/README.md',
  'platform/windows/bridge-contract.json',
  'platform/windows/run-dashboard.ps1',
  'platform/windows/run-dashboard.cmd',
  'platform/android/README.md',
  'platform/android/build-shell.sh',
  'platform/android/verify-shell.mjs',
  'platform/android/bridge-contract.json',
];

for (const relative of required) read(relative);

const contract = json('platform/android/bridge-contract.json');
if (contract.schemaVersion !== 1) throw new Error('Android bridge contract must use schemaVersion 1');
if (contract.platform !== 'android') throw new Error('Android bridge contract platform must be android');
if (!Array.isArray(contract.commands) || contract.commands.length === 0) {
  throw new Error('Android bridge contract must declare commands');
}
if (!Array.isArray(contract.events) || contract.events.length === 0) {
  throw new Error('Android bridge contract must declare events');
}
for (const name of ['getSnapshot', 'executeCommand', 'installAbility']) {
  if (!contract.commands.some((entry) => entry.name === name)) {
    throw new Error(`Android bridge contract missing command ${name}`);
  }
}

const windowsContract = json('platform/windows/bridge-contract.json');
if (windowsContract.schemaVersion !== 1 || windowsContract.platform !== 'windows') {
  throw new Error('Windows bridge contract must use schemaVersion 1 and platform windows');
}
if (windowsContract.status !== 'scaffold' || windowsContract.nativeArtifacts?.signed !== false) {
  throw new Error('Windows bridge contract must remain an unsigned scaffold');
}
if (!windowsContract.surfaces?.includes('global-hotkey')) {
  throw new Error('Windows bridge contract must declare global-hotkey');
}

const windowsPs = read('platform/windows/run-dashboard.ps1');
const windowsCmd = read('platform/windows/run-dashboard.cmd');
if (!windowsPs.includes('apps/dashboard/preview.mjs')) {
  throw new Error('Windows PowerShell launcher must target the offline dashboard preview');
}
if (!windowsCmd.includes('apps\\dashboard\\preview.mjs')) {
  throw new Error('Windows CMD launcher must target the offline dashboard preview');
}

const androidBuild = read('platform/android/build-shell.sh');
if (!androidBuild.includes('PAB_ANDROID_BUILD_MODE')) {
  throw new Error('Android shell script must expose PAB_ANDROID_BUILD_MODE');
}
if (!androidBuild.includes('not built')) {
  throw new Error('Android shell script must state when a native artifact is not built');
}

console.log(`Platform scaffold OK: Windows + Android bridges (${windowsContract.commands.length}/${contract.commands.length} commands)`);
