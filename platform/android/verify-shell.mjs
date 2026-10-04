#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(new URL('./bridge-contract.json', import.meta.url));
const contract = JSON.parse(await readFile(filename, 'utf8'));
assert.equal(contract.schemaVersion, 1);
assert.equal(contract.platform, 'android');
assert.equal(contract.status, 'scaffold');
assert.ok(contract.commands.some((item) => item.name === 'getSnapshot'));
assert.ok(contract.commands.some((item) => item.name === 'installAbility'));
assert.ok(contract.events.includes('capture.created'));
assert.ok(contract.surfaces.includes('share-target'));
assert.deepEqual(contract.nativeArtifacts, { apk: false, aab: false, signed: false });
console.log('Android shell contract: PASS (scaffold only; native artifacts not built)');
