#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, cp, readdir, rm } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertValidManifest, createManifest, validateManifest } from "../../ability-sdk/manifest.js";

const CLI_VERSION = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));
let stripTypeScriptTypes;
try { ({ stripTypeScriptTypes } = await import("node:module")); } catch { /* Node <22: JS abilities still work; TS build reports a useful error. */ }

function usage() {
  console.log(`Personal Ability Base CLI v${CLI_VERSION}

Usage:
  pab create <ability-name> [--dir <directory>] [--force]
  pab validate [<module-directory>]
  pab build [<module-directory>]
  pab dev [<module-directory>] [--check]
  pab pack [<module-directory>] [--out <file>]
  pab --version

Examples:
  pab create pocket-cortex --dir abilities
  pab validate abilities/pocket-cortex
  pab build abilities/pocket-cortex
  pab pack abilities/pocket-cortex --out releases/pocket-cortex-0.1.0.pab
`);
}

function parseOptions(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (key === "force" || key === "check") options[key] = true;
      else options[key] = args[++index];
    } else positional.push(token);
  }
  return { positional, options };
}

async function readManifest(moduleDir) {
  const path = join(moduleDir, "manifest.json");
  if (!existsSync(path)) throw new Error(`manifest.json not found in ${moduleDir}`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Unable to parse ${path}: ${error.message}`); }
}

function formatErrors(errors) { return errors.map((error) => `  ✗ ${error.path}: ${error.message}`).join("\n"); }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectPackageFiles(root, items, prefix = "") {
  const files = [];
  for (const item of items) {
    const absolute = resolve(root, item);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${item}`);
    if (stat.isDirectory()) {
      const children = await readdir(absolute);
      files.push(...await collectPackageFiles(root, children.map((child) => join(item, child)), prefix));
    } else if (stat.isFile()) {
      files.push({ absolute, name: join(prefix, item).split("\\").join("/") });
    }
  }
  return files;
}

async function copySourceTree(sourceRoot, distRoot, relativePath = "") {
  const sourceDirectory = join(sourceRoot, relativePath);
  const targetDirectory = join(distRoot, relativePath);
  await mkdir(targetDirectory, { recursive: true });
  for (const name of await readdir(sourceDirectory, { withFileTypes: true })) {
    const childRelative = join(relativePath, name.name);
    const source = join(sourceRoot, childRelative);
    if (name.isSymbolicLink()) throw new Error(`Refusing to build symlink: ${childRelative}`);
    if (name.isDirectory()) { await copySourceTree(sourceRoot, distRoot, childRelative); continue; }
    if (!name.isFile()) continue;
    if (/\.(tsx?|mts|cts)$/.test(name.name)) {
      if (typeof stripTypeScriptTypes !== "function") throw new Error(`TypeScript source requires Node 22+ (cannot compile ${childRelative}).`);
      const outputName = name.name.replace(/\.(tsx?|mts|cts)$/, ".js");
      const sourceText = await readFile(source, "utf8");
      const stripped = stripTypeScriptTypes(sourceText, { mode: "transform", sourceMap: false })
        .replace(/(from\s*["'][^"']+)\.(?:ts|mts|cts)(["'])/g, "$1.js$2")
        .replace(/(import\s*\(\s*["'][^"']+)\.(?:ts|mts|cts)(["']\s*\))/g, "$1.js$2");
      await writeFile(join(targetDirectory, outputName), stripped);
    } else {
      await cp(source, join(targetDirectory, name.name));
    }
  }
}

/** Write a portable ZIP archive using only Node built-ins (works on Windows). */
async function writeZip(output, root, items) {
  const files = await collectPackageFiles(root, items);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const source = await readFile(file.absolute);
    const compressed = deflateRawSync(source, { level: 9 });
    const method = compressed.length < source.length ? 8 : 0;
    const body = method === 8 ? compressed : source;
    const checksum = crc32(source);
    const local = Buffer.alloc(30 + name.length + body.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    name.copy(local, 30); Buffer.from(body).copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    name.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const centralOffset = offset;
  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBody.length, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  await writeFile(output, Buffer.concat([...locals, centralBody, end]));
}

async function validateModule(moduleDir, { quiet = false, allowSourceEntry = false } = {}) {
  const manifest = await readManifest(moduleDir);
  const result = validateManifest(manifest);
  const entryPath = resolve(moduleDir, manifest.entry ?? "");
  const entryRelative = relative(resolve(moduleDir), entryPath);
  if (manifest.entry && (isAbsolute(entryRelative) || entryRelative === ".." || entryRelative.startsWith(`..${sep}`))) {
    result.errors.push({ path: "entry", message: "entry escapes the module directory." });
  } else if (!existsSync(entryPath)) {
    const sourceEntry = resolve(moduleDir, "src", relative(resolve(moduleDir, "dist"), entryPath));
    const sourceCandidates = [sourceEntry, sourceEntry.replace(/\.js$/, ".ts"), sourceEntry.replace(/\.js$/, ".mts"), sourceEntry.replace(/\.js$/, ".tsx")];
    if (!(allowSourceEntry && sourceCandidates.some((candidate) => existsSync(candidate)))) {
      result.errors.push({ path: "entry", message: `entry file does not exist: ${manifest.entry}` });
    }
  }
  if (!result.valid || result.errors.length) {
    if (!quiet) console.error(`✗ Invalid Ability: ${moduleDir}\n${formatErrors(result.errors)}`);
    return { ...result, valid: false };
  }
  if (!quiet) console.log(`✓ Valid Ability: ${manifest.id}@${manifest.version}`);
  return result;
}

const starterManifest = (name) => createManifest({
  id: `com.pab.${name.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()}`,
  name: name.split(/[-_]/g).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" "),
  displayName: name,
  description: "A Personal Ability Base module.",
  author: "Your Name",
  permissions: ["storage.private"],
  contributes: { pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [] }
});

async function createAbility(name, options) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Ability name must be lowercase kebab-case (for example pocket-cortex).");
  const moduleDir = resolve(options.dir ?? ".", name);
  if (existsSync(moduleDir) && !options.force) throw new Error(`${moduleDir} already exists (pass --force to overwrite).`);
  await mkdir(join(moduleDir, "src"), { recursive: true });
  const manifest = starterManifest(name);
  await writeFile(join(moduleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(moduleDir, "src", "index.js"), `import { defineAbility } from "@pab/ability-sdk";\n\nexport default defineAbility({\n  activate(api) {\n    api.registerCommand({ id: "${name}.hello", title: "Hello ${manifest.name}", execute: () => api.showNotification({ title: "${manifest.name}", body: "Ability activated", level: "success" }) });\n    api.registerCard({ id: "${name}.card", title: "${manifest.name}", render: () => ({ type: "text", text: "Replace this card with your ability UI." }) });\n  },\n  deactivate() {}\n});\n`);
  await writeFile(join(moduleDir, "README.md"), `# ${manifest.name}\n\nGenerated by pab create.\n\n- Edit manifest.json to declare platform, permissions, and contributions.\n- Implement lifecycle in src/index.js.\n- Run pab build ., then pab validate . and pab pack .\n`);
  await writeFile(join(moduleDir, "package.json"), JSON.stringify({ type: "module", private: true, dependencies: { "@pab/ability-sdk": "^0.1.0" } }, null, 2) + "\n");
  console.log(`✓ Created ${moduleDir}\n  Next: cd ${relative(process.cwd(), moduleDir) || "."} && pab build && pab validate`);
}

async function buildModule(moduleDir) {
  const result = await validateModule(moduleDir, { quiet: true, allowSourceEntry: true });
  if (!result.valid) throw new Error(`Cannot build invalid Ability.\n${formatErrors(result.errors)}`);
  const manifest = result.manifest;
  const sourceRoot = join(moduleDir, "src");
  const distRoot = join(moduleDir, "dist");
  if (!existsSync(sourceRoot)) throw new Error(`src directory not found in ${moduleDir}`);
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await copySourceTree(sourceRoot, distRoot);
  // Ensure package entry is exactly what manifest advertises after the copy.
  const entry = resolve(moduleDir, manifest.entry);
  if (!existsSync(entry)) {
    const sourceEntry = resolve(sourceRoot, relative(distRoot, entry));
    if (existsSync(sourceEntry)) await cp(sourceEntry, entry);
  }
  const digest = createHash("sha256").update(await readFile(entry)).digest("hex");
  await writeFile(join(distRoot, "build-info.json"), JSON.stringify({ id: manifest.id, version: manifest.version, entry: manifest.entry, entrySha256: digest, builtAt: new Date().toISOString(), cliVersion: CLI_VERSION }, null, 2) + "\n");
  console.log(`✓ Built ${manifest.id}@${manifest.version}\n  Entry SHA-256: ${digest}`);
  return { manifest, digest };
}

async function devModule(moduleDir, options) {
  const result = await validateModule(moduleDir);
  if (!result.valid) throw new Error("Fix validation errors before starting dev mode.");
  const entry = resolve(moduleDir, result.manifest.entry);
  if (options.check) { console.log(`✓ Dev check passed: ${entry}`); return; }
  console.log(`Starting ${result.manifest.id} in watch mode. Press Ctrl+C to stop.`);
  const runner = resolve(here, "dev-runner.mjs");
  const child = spawnSync(process.execPath, ["--watch", runner, moduleDir], { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 0;
}

async function packModule(moduleDir, options) {
  const result = await validateModule(moduleDir, { quiet: true });
  if (!result.valid) throw new Error(`Cannot pack invalid Ability.\n${formatErrors(result.errors)}`);
  const manifest = result.manifest;
  const out = resolve(options.out ?? join(dirname(moduleDir), `${manifest.id}-${manifest.version}.pab`));
  await mkdir(dirname(out), { recursive: true });
  // A .pab is a ZIP container. Write it in-process so the CLI works on a
  // clean Windows machine without relying on a system `zip` or `tar` binary.
  const packageItems = ["manifest.json", "dist"];
  if (existsSync(join(moduleDir, "README.md"))) packageItems.push("README.md");
  await writeZip(out, moduleDir, packageItems);
  console.log(`✓ Packed ${out}`);
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") { usage(); return; }
  if (command === "--version" || command === "-v") { console.log(CLI_VERSION); return; }
  const { positional, options } = parseOptions(rest);
  const moduleDir = resolve(positional[0] ?? ".");
  if (command === "create") return createAbility(positional[0], options);
  if (command === "validate") return validateModule(moduleDir, { allowSourceEntry: true }).then((result) => { if (!result.valid) process.exitCode = 1; });
  if (command === "build") return buildModule(moduleDir);
  if (command === "dev") return devModule(moduleDir, options);
  if (command === "pack") return packModule(moduleDir, options);
  usage(); process.exitCode = 1;
}

main().catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
