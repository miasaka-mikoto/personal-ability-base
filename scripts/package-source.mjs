#!/usr/bin/env node

/**
 * Build a deterministic, dependency-free PAB source archive.
 *
 * This intentionally uses the ZIP "store" method instead of delegating to a
 * platform zip executable.  The archive therefore has the same bytes on
 * Windows, Android build hosts, and Unix as long as the input files are the
 * same.  No npm dependency (or network access) is required.
 */

import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33; // 1980-01-01 (the minimum valid DOS date).

const ARCHIVE_SUFFIXES = new Set([
  '.7z',
  '.gz',
  '.pab',
  '.rar',
  '.sha256',
  '.sha512',
  '.tar',
  '.tgz',
  '.xz',
  '.zip',
]);

const SECRET_SUFFIXES = new Set(['.jks', '.key', '.p12', '.pem', '.pfx']);
const SECRET_NAMES = new Set(['.netrc', '.npmrc', '.pypirc']);

const ALWAYS_SKIP_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.agents',
  '.aws',
  '.codex',
  '.DS_Store',
  'node_modules',
  'coverage',
  'demo-data',
  'userdata',
  'artifacts',
]);

const ALWAYS_SKIP_PATHS = new Set([
  'apps/dashboard/.vite',
  'apps/dashboard/.cache',
  '.cache',
  '.tmp',
  'tmp',
]);

function usage() {
  return `Usage: node scripts/package-source.mjs [options]

Options:
  --root <dir>       Repository root (default: inferred from this script)
  --output <file>    ZIP path (default: artifacts/PersonalAbilityBase-v<version>-source.zip)
  --sha256 <file>    Checksum path (default: <output>.sha256)
  --version <value>  Archive version label (default: package.json version)
  --verify <file>    Verify an existing archive against its .sha256 sidecar
  --dry-run          List included files without writing an archive
  --help             Show this help

The archive is deterministic: paths are sorted, timestamps and permissions are
normalized, and files are stored without a platform-specific compressor.
Archives, dependencies, generated caches, user data, and the output directory
are excluded automatically. Symlinks are skipped to keep the artifact inside
the repository boundary.
`;
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    output: undefined,
    sha256: undefined,
    version: undefined,
    verify: undefined,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--root' || arg === '--output' || arg === '--sha256' || arg === '--version' || arg === '--verify') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--root') options.root = resolve(value);
      if (arg === '--output') options.output = resolve(value);
      if (arg === '--sha256') options.sha256 = resolve(value);
      if (arg === '--version') options.version = value;
      if (arg === '--verify') options.verify = resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  options.root = resolve(options.root);
  return options;
}

function normalizeZipPath(pathname) {
  return pathname.split(sep).join('/').replace(/^\.\//, '');
}

function comparePaths(left, right) {
  // Do not use localeCompare here: ICU versions can order punctuation and
  // case differently, which would make an otherwise identical archive vary
  // between build hosts.
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/'));
}

function shouldSkipDirectory(zipPath, name) {
  if (ALWAYS_SKIP_NAMES.has(name)) return true;
  if (ALWAYS_SKIP_PATHS.has(zipPath)) return true;
  // Keep official Ability build output, but omit unrelated generated dist trees.
  if (name === 'dist' && !zipPath.startsWith('abilities/')) return true;
  return false;
}

function shouldSkipFile(zipPath, name) {
  if (name === '.DS_Store') return true;
  if (SECRET_NAMES.has(name.toLowerCase())) return true;
  if (ARCHIVE_SUFFIXES.has(name.toLowerCase().slice(name.lastIndexOf('.')))) return true;
  if (SECRET_SUFFIXES.has(name.toLowerCase().slice(name.lastIndexOf('.')))) return true;
  if (name.startsWith('.env')) return true;
  if (zipPath.endsWith('.log') || zipPath.endsWith('.tmp')) return true;
  return false;
}

async function collectEntries(root, outputPath, checksumPath) {
  const entries = [];
  const skipped = [];

  async function visit(absoluteDir) {
    const names = (await readdir(absoluteDir)).sort(comparePaths);
    for (const name of names) {
      const absolutePath = resolve(absoluteDir, name);
      const zipPath = normalizeZipPath(relative(root, absolutePath));

      if (isInside(absolutePath, outputPath) || isInside(absolutePath, checksumPath)) {
        skipped.push({ path: zipPath, reason: 'output' });
        continue;
      }

      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        skipped.push({ path: zipPath, reason: 'symlink' });
        continue;
      }
      if (info.isDirectory()) {
        if (shouldSkipDirectory(zipPath, name)) {
          skipped.push({ path: `${zipPath}/`, reason: 'excluded-directory' });
          continue;
        }
        // Preserve empty directories so a checkout has the same shape.
        const childNames = await readdir(absolutePath);
        if (childNames.length === 0) entries.push({ type: 'directory', path: `${zipPath}/` });
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: zipPath, reason: 'unsupported-file-type' });
        continue;
      }
      if (shouldSkipFile(zipPath, name)) {
        skipped.push({ path: zipPath, reason: 'excluded-file' });
        continue;
      }
      entries.push({ type: 'file', path: zipPath, absolutePath });
    }
  }

  await visit(root);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return { entries, skipped };
}

// Standard CRC-32 (IEEE 802.3) used by ZIP headers.
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

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function zipLocalHeader(name, data, crc) {
  const nameBytes = Buffer.from(name, 'utf8');
  return Buffer.concat([
    u32(0x04034b50),
    u16(20), // version needed
    u16(0x0800), // UTF-8 names
    u16(0), // store
    u16(FIXED_DOS_TIME),
    u16(FIXED_DOS_DATE),
    u32(crc),
    u32(data.length),
    u32(data.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
  ]);
}

function zipCentralHeader(name, data, crc, offset, isDirectory) {
  const nameBytes = Buffer.from(name, 'utf8');
  return Buffer.concat([
    u32(0x02014b50),
    u16(20), // made by (platform-neutral)
    u16(20), // version needed
    u16(0x0800),
    u16(0),
    u16(FIXED_DOS_TIME),
    u16(FIXED_DOS_DATE),
    u32(crc),
    u32(data.length),
    u32(data.length),
    u16(nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(isDirectory ? 0x10 : 0),
    u32(offset),
    nameBytes,
  ]);
}

function zipEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entryCount),
    u16(entryCount),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  ]);
}

async function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = entry.type === 'file' ? await readFile(entry.absolutePath) : Buffer.alloc(0);
    const crc = crc32(data);
    const local = zipLocalHeader(entry.path, data, crc);
    localParts.push(local, data);
    centralParts.push(zipCentralHeader(entry.path, data, crc, offset, entry.type === 'directory'));
    offset += local.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    zipEndOfCentralDirectory(entries.length, central.length, offset),
  ]);
}

function safeVersion(value) {
  const normalized = String(value || '0.0.0').trim().replace(/[^0-9A-Za-z.+-]/g, '-');
  return normalized || '0.0.0';
}

async function loadVersion(root, explicitVersion) {
  if (explicitVersion) return safeVersion(explicitVersion);
  try {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    return safeVersion(packageJson.version);
  } catch {
    return '0.0.0';
  }
}

async function writeAtomically(pathname, data) {
  await mkdir(dirname(pathname), { recursive: true });
  const temporaryPath = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o644 });
    try {
      await rename(temporaryPath, pathname);
    } catch (error) {
      // Node's rename replaces atomically on POSIX, while Windows can reject
      // an existing destination. Retry only for that platform-specific case.
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await rm(pathname, { force: true });
      await rename(temporaryPath, pathname);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function verifyArchive(archivePath, checksumPath) {
  const archive = await readFile(archivePath);
  const actual = createHash('sha256').update(archive).digest('hex');
  const sidecar = await readFile(checksumPath, 'utf8');
  const match = sidecar.match(/^([0-9a-f]{64})\s+(?:\*?)(.+?)\s*$/im);
  if (!match) throw new Error(`invalid checksum sidecar: ${checksumPath}`);
  if (match[1].toLowerCase() !== actual) {
    throw new Error(`SHA-256 mismatch for ${archivePath}: expected ${match[1]}, got ${actual}`);
  }
  console.log(`Verified ${archivePath}`);
  console.log(`SHA-256 ${actual}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  if (options.verify) {
    await verifyArchive(options.verify, options.sha256 || `${options.verify}.sha256`);
    return;
  }
  const version = await loadVersion(root, options.version);
  const outputPath = options.output || resolve(root, 'artifacts', `PersonalAbilityBase-v${version}-source.zip`);
  const checksumPath = options.sha256 || `${outputPath}.sha256`;

  if (!isInside(outputPath, root) && !options.dryRun) {
    // An external output is supported, but still make the intent explicit in
    // logs; this is useful for CI writing to a release staging directory.
    console.error(`Packaging source outside repository: ${outputPath}`);
  }

  const { entries, skipped } = await collectEntries(root, resolve(outputPath), resolve(checksumPath));
  if (entries.length > 0xffff) throw new Error('ZIP entry count exceeds classic ZIP limit (65,535)');

  if (options.dryRun) {
    for (const entry of entries) console.log(entry.path);
    console.error(`Included ${entries.length} entries; skipped ${skipped.length}.`);
    return;
  }

  const archive = await createZip(entries);
  const digest = createHash('sha256').update(archive).digest('hex');
  await writeAtomically(outputPath, archive);
  const checksumText = `${digest}  ${outputPath.split(/[\\/]/).pop()}\n`;
  await writeAtomically(checksumPath, checksumText);

  // Make the artifact readable even when a caller's umask is restrictive.
  await chmod(outputPath, 0o644);
  await chmod(checksumPath, 0o644);
  console.log(`Created ${outputPath}`);
  console.log(`SHA-256 ${digest}`);
  console.log(`Included ${entries.length} entries; skipped ${skipped.length}.`);
}

main().catch((error) => {
  console.error(`package-source: ${error.message}`);
  process.exitCode = 1;
});
