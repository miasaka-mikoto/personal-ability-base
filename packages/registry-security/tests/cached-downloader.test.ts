import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbilityInstaller,
  CachedPackageDownloader,
  FetchPackageDownloader,
  MemoryPackageDownloader,
  ModuleStore,
  PackageCache,
  PabRegistryError,
  sha256Hex,
} from "../src/index.ts";
import type { AbilityRegistryEntry } from "../src/types.ts";

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

// Real, tiny filesystem cache fixtures; HTTP responses stay in-process.
test("cached downloader applies each call's budget on a valid cache hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-budget-"));
  try {
    const bytes = new Uint8Array(64).fill(7);
    const expectedSha256 = sha256Hex(bytes);
    const url = "https://example.invalid/package";
    let requests = 0;
    const cache = new PackageCache(root);
    const downloader = new CachedPackageDownloader(cache, new FetchPackageDownloader(async () => {
      requests += 1;
      return new Response(bytes);
    }));
    assert.deepEqual((await downloader.download(url, { maxBytes: 64, expectedSha256 })).bytes, bytes);
    await assert.rejects(() => downloader.download(url, { maxBytes: 32, expectedSha256 }),
      (error: unknown) => error instanceof PabRegistryError && error.code === "PACKAGE_TOO_LARGE" && error.details.maxBytes === 32);
    assert.equal(requests, 1, "a valid oversized cache hit must not retry upstream");
    assert.deepEqual((await downloader.download(url, { maxBytes: 64, expectedSha256 })).bytes, bytes);
    assert.deepEqual((await downloader.download(url, { expectedSha256 })).bytes, bytes);
    assert.equal(requests, 1);
    assert.equal(await cache.size(expectedSha256), 64, "rejection does not evict existing valid content");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cached downloader preserves cold and corrupt misses with a size-limited upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-miss-"));
  try {
    const bytes = new Uint8Array(64).fill(9);
    const expectedSha256 = sha256Hex(bytes);
    const url = "https://example.invalid/package";
    let requests = 0;
    const cache = new PackageCache(root);
    const downloader = new CachedPackageDownloader(cache, new FetchPackageDownloader(async () => {
      requests += 1;
      return new Response(bytes);
    }));
    await assert.rejects(() => downloader.download(url, { maxBytes: 32, expectedSha256 }),
      (error: unknown) => error instanceof PabRegistryError && error.code === "PACKAGE_TOO_LARGE");
    assert.deepEqual(await readdir(root), [], "cold rejection must not populate the cache");
    assert.equal(requests, 1);
    await downloader.download(url, { maxBytes: 64, expectedSha256 });
    const corrupt = new Uint8Array(bytes); corrupt[0] ^= 1;
    await writeFile(join(root, `${expectedSha256}.pkg`), corrupt);
    await assert.rejects(() => downloader.download(url, { maxBytes: 32, expectedSha256 }),
      (error: unknown) => error instanceof PabRegistryError && error.code === "PACKAGE_TOO_LARGE");
    assert.equal(requests, 3, "corrupt content must miss and reach upstream");
    assert.deepEqual(new Uint8Array(await readFile(join(root, `${expectedSha256}.pkg`))), corrupt);
    assert.deepEqual((await downloader.download(url, { maxBytes: 64, expectedSha256 })).bytes, bytes);
    assert.equal(requests, 4);
    assert.deepEqual(await cache.get(expectedSha256), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cached downloader rejects an oversized upstream result before caching, with or without a digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-upstream-"));
  try {
    const bytes = new Uint8Array(64).fill(11);
    const hash = sha256Hex(bytes);
    const url = "memory://oversized";
    const cache = new PackageCache(root);
    const downloader = new CachedPackageDownloader(cache, new MemoryPackageDownloader({ [url]: bytes }));
    for (const expectedSha256 of [hash, undefined]) {
      await assert.rejects(() => downloader.download(url, { maxBytes: 32, expectedSha256 }),
        (error: unknown) => error instanceof PabRegistryError && error.code === "PACKAGE_TOO_LARGE");
      assert.deepEqual(await readdir(root), [], "oversized upstream bytes must not be written");
    }
    assert.deepEqual((await downloader.download(url, { maxBytes: 64, expectedSha256: hash })).bytes, bytes);
    assert.deepEqual(await cache.get(hash), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cached downloader leaves omitted budgets and upstream metadata unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-default-"));
  try {
    const bytes = new Uint8Array(64).fill(13);
    const result = { bytes, url: "memory://response", etag: "fixture" };
    const signal = new AbortController().signal;
    const options = { signal, expectedSha256: sha256Hex(bytes) };
    let requests = 0;
    const downloader = new CachedPackageDownloader(new PackageCache(root), {
      async download(url, receivedOptions) {
        requests += 1;
        assert.equal(url, "memory://request");
        assert.equal(receivedOptions, options);
        assert.equal(receivedOptions?.maxBytes, undefined);
        return result;
      },
    });
    assert.equal(await downloader.download("memory://request", options), result);
    assert.deepEqual((await downloader.download("memory://request", options)).bytes, bytes);
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cached downloader accepts an empty package at a zero budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-zero-"));
  try {
    const bytes = new Uint8Array();
    const url = "memory://empty";
    const options = { maxBytes: 0, expectedSha256: sha256Hex(bytes) };
    const downloader = new CachedPackageDownloader(new PackageCache(root), new MemoryPackageDownloader({ [url]: bytes }));
    assert.equal((await downloader.download(url, options)).bytes.byteLength, 0);
    assert.equal((await downloader.download(url, options)).bytes.byteLength, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installer rechecks signatures on cache hits after the current byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cache-signature-"));
  try {
    const bytes = new Uint8Array(64).fill(17);
    const item = entry("com.test.cached-signature", "1.0.0", bytes, { trust: "official" });
    const cache = new PackageCache(join(root, "cache"));
    let downloads = 0; let extractions = 0;
    const downloader = new CachedPackageDownloader(cache, {
      async download(url) { downloads += 1; return { bytes, url }; },
    });
    const installOptions = { platform: "windows" as const, coreVersion: "1.0.0", approvedPermissions: [] };
    const store = new ModuleStore({ root: join(root, "store") });
    const extractor = { async extract() { extractions += 1; } };
    const installer = new AbilityInstaller({ store, downloader, extractor, maxPackageBytes: 64 });
    await assert.rejects(() => installer.install(item, installOptions),
      (error: unknown) => error instanceof PabRegistryError && error.code === "SIGNATURE_INVALID");
    assert.equal(downloads, 1);
    assert.deepEqual(await cache.get(item.sha256), bytes, "caching still precedes signature validation");
    await assert.rejects(() => installer.install(item, installOptions),
      (error: unknown) => error instanceof PabRegistryError && error.code === "SIGNATURE_INVALID");
    const strict = new AbilityInstaller({ store, downloader, extractor, maxPackageBytes: 32 });
    await assert.rejects(() => strict.install(item, installOptions),
      (error: unknown) => error instanceof PabRegistryError && error.code === "PACKAGE_TOO_LARGE");
    assert.equal(downloads, 1);
    assert.equal(extractions, 0);
    assert.deepEqual(await readdir(store.stagingRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
