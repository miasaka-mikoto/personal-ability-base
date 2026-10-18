import "./cached-downloader.test.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  AbilityInstaller,
  DependencyResolver,
  GitHubRegistrySource,
  GitHubAbilityStore,
  JsonPackageExtractor,
  MemoryPackageDownloader,
  ModuleStore,
  PabRegistryError,
  RegistryCacheStore,
  TrustPolicy,
  ZipPackageExtractor,
  compareVersions,
  maxSatisfying,
  satisfies,
  sha256Hex,
  validateRegistry,
} from "../src/index.ts";
import type { AbilityRegistryEntry, RegistryDocument } from "../src/types.ts";

function packageFixture(id: string, version: string, manifestOverrides: Record<string, unknown> = {}): Uint8Array {
  const manifest = {
    schemaVersion: 1, id, name: id, displayName: id, version, description: "fixture", author: "test",
    minCoreVersion: "0.1.0", platforms: ["windows", "android"], permissions: [], dependencies: {}, optionalDependencies: {},
    contributes: { pages: [] }, entry: "dist/index.js", ...manifestOverrides,
  };
  return new TextEncoder().encode(JSON.stringify({ files: { "manifest.json": JSON.stringify(manifest), "dist/index.js": "export default {};" } }));
}

function entry(id: string, version: string, bytes: Uint8Array, extra: Partial<AbilityRegistryEntry> = {}): AbilityRegistryEntry {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version,
    repository: `https://github.com/PersonalAbilityBase/${id}`,
    packageUrl: `memory://${id}/${version}`,
    sha256: sha256Hex(bytes),
    trust: "community",
    platforms: ["windows", "android"],
    minCoreVersion: "0.1.0",
    ...extra,
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<[string, string]>, compress = false): Uint8Array {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name); const source = Buffer.from(content); const compressed = compress ? deflateRawSync(source) : source;
    const method = compress ? 8 : 0; const crc = crc32(source);
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30); compressed.copy(local, 30 + nameBytes.length); locals.push(local);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const body = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(body.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, body, eocd]));
}

function storedZip(name: string, content: string): Uint8Array { return zip([[name, content]]); }

test("semver ranges and max satisfying are deterministic", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9") > 0, true);
  assert.equal(satisfies("1.4.2", "^1.2.0"), true);
  assert.equal(satisfies("2.0.0", "^1.2.0"), false);
  assert.equal(satisfies("1.3.9", "~1.3"), true);
  assert.equal(maxSatisfying(["1.0.0", "1.4.0", "2.0.0"], "^1.0.0"), "1.4.0");
});

test("registry validation rejects duplicate and malformed entries", () => {
  const bytes = packageFixture("com.test.a", "1.0.0");
  const valid = { schemaVersion: 1, abilities: [entry("com.test.a", "1.0.0", bytes)] };
  assert.equal(validateRegistry(valid).abilities.length, 1);
  assert.throws(() => validateRegistry({ ...valid, abilities: [...valid.abilities, valid.abilities[0]] }), (error: unknown) => error instanceof PabRegistryError && error.code === "INVALID_REGISTRY");
  assert.throws(() => validateRegistry({ ...valid, packs: [{ id: "broken-pack", name: "Broken", abilities: ["com.missing.ability"] }] }), (error: unknown) => error instanceof PabRegistryError && error.code === "INVALID_REGISTRY");
  assert.throws(() => validateRegistry({ ...valid, loadouts: [{ id: "broken-loadout", name: "Broken", abilityIds: ["com.missing.ability"] }] }), (error: unknown) => error instanceof PabRegistryError && error.code === "INVALID_REGISTRY");
});

test("registry cache saves, loads and falls back to stale data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-registry-cache-"));
  try {
    let now = new Date("2026-01-01T00:00:00Z");
    const cache = new RegistryCacheStore(root, { maxAgeMs: 1000, now: () => now });
    const bytes = packageFixture("com.test.cache", "1.0.0");
    const document = { schemaVersion: 1, abilities: [entry("com.test.cache", "1.0.0", bytes)] } as RegistryDocument;
    await cache.save(document, { sourceUrl: "memory://registry" });
    now = new Date("2026-01-01T00:01:00Z");
    const loaded = await cache.load({ allowStale: true });
    assert.equal(loaded?.meta.stale, true);
    assert.equal(loaded?.meta.sourceUrl, "memory://registry");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub registry source builds a raw content URL", async () => {
  let requested = "";
  const source = new GitHubRegistrySource("PersonalAbilityBase", "Registry", "abilities/registry.json", "main", async (url) => { requested = String(url); return new Response(JSON.stringify({ schemaVersion: 1, abilities: [] }), { status: 200 }); });
  await source.fetch();
  assert.equal(source.owner, "PersonalAbilityBase");
  assert.equal(source.path, "abilities/registry.json");
  assert.equal(source.ref, "main");
  assert.equal(requested, "https://raw.githubusercontent.com/PersonalAbilityBase/Registry/main/abilities/registry.json");
});

test("trust policy verifies hash and Ed25519 detached signature", () => {
  const bytes = packageFixture("com.test.signed", "1.0.0");
  const keys = generateKeyPairSync("ed25519");
  const signature = sign(null, bytes, keys.privateKey).toString("base64");
  const item = entry("com.test.signed", "1.0.0", bytes, { trust: "official", signature: { algorithm: "ed25519", keyId: "test", value: signature } });
  const policy = new TrustPolicy({ trustedKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } });
  assert.equal(policy.assertAllowed(item, bytes).signatureValid, true);
  const tampered = new Uint8Array(bytes); tampered[0] ^= 1;
  assert.throws(() => policy.assertAllowed(item, tampered), (error: unknown) => error instanceof PabRegistryError && error.code === "HASH_MISMATCH");
});

test("installer blocks untrusted sources before downloading", async () => {
  const bytes = packageFixture("com.test.untrusted", "1.0.0");
  let downloads = 0;
  const downloader = { download: async () => { downloads += 1; return { bytes, url: "memory://untrusted" }; } };
  const root = await mkdtemp(join(tmpdir(), "pab-trust-"));
  try {
    const installer = new AbilityInstaller({ store: new ModuleStore({ root }), downloader, extractor: new JsonPackageExtractor() });
    await assert.rejects(() => installer.install(entry("com.test.untrusted", "1.0.0", bytes, { trust: "community", packageUrl: "memory://untrusted" }), { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] }), (error: unknown) => error instanceof PabRegistryError && error.code === "TRUST_BLOCKED");
    assert.equal(downloads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency resolver selects highest compatible versions and detects cycles", () => {
  const a10 = packageFixture("com.test.a", "1.0.0");
  const a20 = packageFixture("com.test.a", "2.0.0");
  const b10 = packageFixture("com.test.b", "1.0.0");
  const document = { schemaVersion: 1, abilities: [
    entry("com.test.a", "1.0.0", a10), entry("com.test.a", "2.0.0", a20),
    entry("com.test.b", "1.0.0", b10, { dependencies: { "com.test.a": "^1.0.0" } }),
  ] } as RegistryDocument;
  const resolution = new DependencyResolver(document, { platform: "windows", coreVersion: "1.0.0" }).resolve({ "com.test.b": "*" });
  assert.deepEqual(resolution.order, ["com.test.a", "com.test.b"]);
  assert.equal(resolution.selected["com.test.a"].version, "1.0.0");
  const cycle = { ...document, abilities: [entry("com.test.a", "1.0.0", a10, { dependencies: { "com.test.b": "*" } }), entry("com.test.b", "1.0.0", b10, { dependencies: { "com.test.a": "*" } })] } as RegistryDocument;
  assert.throws(() => new DependencyResolver(cycle, { platform: "windows", coreVersion: "1.0.0" }).resolve({ "com.test.a": "*" }), (error: unknown) => error instanceof PabRegistryError && error.code === "DEPENDENCY_CYCLE");
});

test("installer keeps versioned modules for rollback and leaves user data on uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-install-"));
  try {
    const one = packageFixture("com.test.install", "1.0.0");
    const two = packageFixture("com.test.install", "1.1.0");
    const downloader = new MemoryPackageDownloader({ "memory://com.test.install/1.0.0": one, "memory://com.test.install/1.1.0": two });
    const store = new ModuleStore({ root });
    const installer = new AbilityInstaller({ store, downloader, extractor: new JsonPackageExtractor(), trustPolicy: new TrustPolicy({ allowedLevels: ["community"] }) });
    await installer.install(entry("com.test.install", "1.0.0", one), { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    await store.disable("com.test.install");
    await installer.install(entry("com.test.install", "1.1.0", two), { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    assert.equal((await store.getState("com.test.install"))?.activeVersion, "1.1.0");
    assert.equal((await store.getState("com.test.install"))?.enabled, false);
    await store.rollback("com.test.install", "1.0.0");
    assert.equal((await store.getState("com.test.install"))?.activeVersion, "1.0.0");
    await store.uninstall("com.test.install");
    assert.equal(await store.getState("com.test.install"), undefined);
    // User data is in a separate tree and survives module removal.
    await mkdir(join(root, "userdata", "abilities", "com.test.install"), { recursive: true });
    await writeFile(join(root, "userdata", "abilities", "com.test.install", "memory.json"), "{}");
    const reinstall = await installer.install(entry("com.test.install", "1.0.0", one), { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    assert.equal(reinstall.warnings.some((warning) => warning.includes("Previous user data")), true);
    await readFile(join(root, "userdata", "abilities", "com.test.install", "memory.json"), "utf8");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive adapter blocks path traversal in local package fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-archive-"));
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ files: { "../escape.txt": "no" } }));
    const downloader = new MemoryPackageDownloader({ "memory://bad": bytes });
    const item = entry("com.test.bad", "1.0.0", bytes, { packageUrl: "memory://bad" });
    const installer = new AbilityInstaller({ store: new ModuleStore({ root }), downloader, extractor: new JsonPackageExtractor(), trustPolicy: new TrustPolicy({ allowedLevels: ["community"] }) });
    await assert.rejects(() => installer.install(item, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] }), (error: unknown) => error instanceof PabRegistryError && error.code === "PATH_TRAVERSAL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ZIP extractor blocks path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-zip-"));
  try {
    await assert.rejects(() => new ZipPackageExtractor().extract(storedZip("../escape.txt", "no"), root), (error: unknown) => error instanceof PabRegistryError && error.code === "PATH_TRAVERSAL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ZIP extractor reads stored release entries and verifies CRC", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-zip-valid-"));
  try {
    await new ZipPackageExtractor().extract(storedZip("dist/index.js", "export default 42;"), root);
    assert.equal(await readFile(join(root, "dist/index.js"), "utf8"), "export default 42;");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("default installer accepts a deflated .pab ZIP release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-zip-install-"));
  try {
    const id = "com.test.zip-release";
    const manifest = {
      schemaVersion: 1, id, name: "ZIP release", displayName: "ZIP release", version: "1.0.0", description: "fixture", author: "test",
      minCoreVersion: "0.1.0", platforms: ["windows", "android"], permissions: [], dependencies: {}, optionalDependencies: {}, contributes: { pages: [] }, entry: "dist/index.js",
    };
    const bytes = zip([["manifest.json", JSON.stringify(manifest)], ["dist/index.js", "export default 42;"]], true);
    const item = entry(id, "1.0.0", bytes, { packageUrl: "memory://zip-release", platforms: ["windows"] });
    const installer = new AbilityInstaller({ store: new ModuleStore({ root }), downloader: new MemoryPackageDownloader({ "memory://zip-release": bytes }), trustPolicy: new TrustPolicy({ allowedLevels: ["community"] }) });
    const result = await installer.install(item, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    assert.equal(result.activated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub Ability Store facade refreshes offline cache, searches and installs a pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-store-"));
  try {
    const a = packageFixture("com.test.store-a", "1.0.0");
    const b = packageFixture("com.test.store-b", "1.0.0", { dependencies: { "com.test.store-a": "^1.0.0" } });
    const aEntry = entry("com.test.store-a", "1.0.0", a, { packageUrl: "memory://store-a" });
    const bEntry = entry("com.test.store-b", "1.0.0", b, { packageUrl: "memory://store-b", dependencies: { "com.test.store-a": "^1.0.0" } });
    const document = { schemaVersion: 1, abilities: [aEntry, bEntry], packs: [{ id: "store-pack", name: "Store Pack", abilities: ["com.test.store-b"] }] } as RegistryDocument;
    const cache = new RegistryCacheStore(join(root, "registry"));
    const source = { fetch: async () => ({ document }) };
    const moduleStore = new ModuleStore({ root: join(root, "modules") });
    const installer = new AbilityInstaller({
      store: moduleStore,
      downloader: new MemoryPackageDownloader({ "memory://store-a": a, "memory://store-b": b }),
      extractor: new JsonPackageExtractor(),
      trustPolicy: new TrustPolicy({ allowedLevels: ["community"] }),
    });
    const store = new GitHubAbilityStore({ cache, source, installer, moduleStore, platform: "windows", coreVersion: "1.0.0" });
    await store.refresh();
    assert.equal((await store.find("store-b"))[0].id, "com.test.store-b");
    const result = await store.installPack("store-pack", { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    assert.deepEqual(result.results.map((item) => item.id), ["com.test.store-a", "com.test.store-b"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("update policy persists and honors automatic/manual, ignored, pinned and force controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-update-policy-"));
  try {
    const id = "com.test.update-policy";
    const one = packageFixture(id, "1.0.0");
    const two = packageFixture(id, "1.1.0");
    const oneEntry = entry(id, "1.0.0", one, { packageUrl: "memory://update-1" });
    const twoEntry = entry(id, "1.1.0", two, { packageUrl: "memory://update-2" });
    const document = { schemaVersion: 1, abilities: [oneEntry, twoEntry] } as RegistryDocument;
    const moduleStore = new ModuleStore({ root: join(root, "modules") });
    const installer = new AbilityInstaller({
      store: moduleStore,
      downloader: new MemoryPackageDownloader({ "memory://update-1": one, "memory://update-2": two }),
      extractor: new JsonPackageExtractor(),
      trustPolicy: new TrustPolicy({ allowedLevels: ["community"] }),
    });
    const store = new GitHubAbilityStore({
      cache: new RegistryCacheStore(join(root, "registry")),
      source: { fetch: async () => ({ document }) },
      installer, moduleStore, platform: "windows", coreVersion: "1.0.0",
    });
    await store.refresh();
    await store.install(id, { range: "=1.0.0", platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    await store.setUpdateMode(id, "automatic");
    await store.ignoreVersion(id, "1.1.0");
    const ignored = await store.update(id, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [], trigger: "automatic" });
    assert.equal(ignored.skipped, "ignored");
    await store.setUpdateMode(id, "manual");
    const manualRequired = await store.update(id, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [], trigger: "automatic" });
    assert.equal(manualRequired.skipped, "manual-required");
    await store.unignoreVersion(id, "1.1.0");
    const updated = await store.update(id, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [], trigger: "manual" });
    assert.equal(updated.updated, true);
    await store.pinVersion(id, "1.0.0");
    const pinned = await store.update(id, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [] });
    assert.equal(pinned.entry.version, "1.0.0");
    assert.equal((await moduleStore.getState(id))?.activeVersion, "1.0.0");
    await store.pinVersion(id, undefined);
    await store.ignoreVersion(id, "1.1.0");
    const forced = await store.update(id, { platform: "windows", coreVersion: "1.0.0", approvedPermissions: [], force: true });
    assert.equal(forced.updated, true);
    assert.equal((await moduleStore.getState(id))?.activeVersion, "1.1.0");
    const reloaded = new ModuleStore({ root: join(root, "modules") });
    assert.deepEqual(await reloaded.getUpdatePolicy(id), { mode: "manual", ignoredVersions: ["1.1.0"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
