#!/usr/bin/env node

/** Validate a locally prepared release bundle without contacting a registry. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const releaseDir = path.join(root, 'dist', 'releases');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedVersion = String(process.env.PAB_RELEASE_VERSION || packageJson.version || '0.0.0')
  .trim().replace(/^v(?=\d)/i, '').replace(/[^0-9A-Za-z.+-]/g, '-') || '0.0.0';

function fail(message) {
  console.error(`Release check failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) fail('dist/releases does not exist; run npm run release:source first');
const archives = fs.readdirSync(releaseDir)
  .filter((name) => /^pab-.+-source\.zip$/.test(name))
  .sort();
if (archives.length === 0) fail('no pab-*-source.zip found');

const expectedArchive = `pab-v${expectedVersion}-source.zip`;
const archiveName = archives.includes(expectedArchive) ? expectedArchive : archives.at(-1);
const archivePath = path.join(releaseDir, archiveName);
const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inspect the deterministic store-only ZIP emitted by scripts/package-source.
 * Keeping this parser here avoids requiring `unzip`/`zipinfo` on Windows.
 */
function inspectStoreZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > buffer.length) throw new Error('truncated local ZIP header');
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new Error('data-descriptor ZIP entries are not accepted in source lane');
    if (method !== 0) throw new Error('compressed ZIP entry found; source lane requires store-only entries');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error('truncated ZIP entry');
    const name = buffer.subarray(nameStart, dataStart - extraLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataEnd);
    if (compressedSize !== uncompressedSize || crc32(data) !== expectedCrc) {
      throw new Error(`ZIP CRC/size mismatch for ${name}`);
    }
    entries.push(name);
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error('ZIP has no local entries');
  if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error('ZIP central directory is missing or malformed');
  }
  return entries;
}

const metadataFiles = fs.readdirSync(releaseDir)
  .filter((name) => name.endsWith('.manifest.json') || name.endsWith('-manifest.json'))
  .sort();
let metadata = null;
let metadataName = null;
for (const name of metadataFiles) {
  try {
    const candidate = JSON.parse(fs.readFileSync(path.join(releaseDir, name), 'utf8'));
    if (candidate.file === archiveName || candidate.artifact === archiveName || candidate.filename === archiveName) {
      metadata = candidate;
      metadataName = name;
      break;
    }
  } catch {
    // A malformed sidecar will be reported below if it is the only candidate.
  }
}
if (!metadata) fail(`no manifest sidecar references ${archiveName}`);
if (metadata.version && String(metadata.version) !== expectedVersion) {
  fail(`manifest version ${metadata.version} does not match expected ${expectedVersion}`);
}
if (metadata.bytes !== undefined && Number(metadata.bytes) !== fs.statSync(archivePath).size) {
  fail(`manifest byte count does not match ${archiveName}`);
}
if (typeof metadata.sha256 !== 'string' || metadata.sha256.toLowerCase() !== digest) {
  fail(`manifest ${metadataName} SHA-256 does not match archive`);
}
if (metadata.signed === true || metadata.signatureStatus === 'valid') {
  fail('source archive is marked signed although this lane has no signing key');
}

let entries;
try {
  entries = inspectStoreZip(fs.readFileSync(archivePath));
} catch (error) {
  fail(`ZIP integrity check failed: ${error.message}`);
}
const forbidden = entries.filter((name) => /\.(pem|key|p12|pfx|jks)$/i.test(name));
if (forbidden.length) fail(`release contains signing material: ${forbidden.join(', ')}`);

const statusPath = path.join(releaseDir, 'release-status.json');
if (fs.existsSync(statusPath)) {
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  if (status.releaseClass && status.releaseClass !== 'source-only-unsigned') {
    fail(`unexpected releaseClass=${status.releaseClass}`);
  }
  if (Array.isArray(status.signedArtifacts) && status.signedArtifacts.length > 0) {
    fail('release-status lists signed artifacts, but no signing lane ran');
  }
}

console.log(`Release bundle OK: ${archiveName}`);
console.log(`SHA-256: ${digest}`);
console.log('Signing status: source-only / unsigned (expected for v0.2 scaffold)');
