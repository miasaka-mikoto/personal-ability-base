#!/usr/bin/env node

/**
 * Release-facing wrapper around the deterministic source packer.  The lower
 * level packer lives in scripts/package-source.mjs so it can also be used by
 * local tooling; this wrapper adds the release manifest and explicit
 * source-only status consumed by check-release.mjs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rawVersion = String(process.env.PAB_RELEASE_VERSION || packageJson.version || '0.0.0')
  .trim().replace(/^v(?=\d)/i, '');
const version = rawVersion.replace(/[^0-9A-Za-z.+-]/g, '-') || '0.0.0';
const releaseDir = path.join(root, 'dist', 'releases');
const archiveName = `pab-v${version}-source.zip`;
const archivePath = path.join(releaseDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
const manifestPath = `${archivePath}.manifest.json`;
const statusPath = path.join(releaseDir, 'release-status.json');

fs.mkdirSync(releaseDir, { recursive: true });
const packer = path.join(root, 'scripts', 'package-source.mjs');
const result = spawnSync(process.execPath, [
  packer,
  '--version', version,
  '--output', archivePath,
  '--sha256', checksumPath,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const bytes = fs.statSync(archivePath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
const manifest = {
  schemaVersion: 1,
  project: 'personal-ability-base',
  version,
  artifactType: 'source-only',
  file: archiveName,
  bytes,
  sha256,
  signed: false,
  signatureStatus: 'not-configured',
  nativeArtifacts: { windowsExe: false, androidApk: false, androidAab: false },
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(statusPath, `${JSON.stringify({
  schemaVersion: 1,
  releaseClass: 'source-only-unsigned',
  signedArtifacts: [],
  artifacts: [archiveName],
  note: 'No native installer or signed mobile artifact is produced by this lane.',
}, null, 2)}\n`);

console.log(`Release source bundle: ${archivePath}`);
console.log(`Release manifest: ${manifestPath}`);
console.log(`Release status: ${statusPath}`);
