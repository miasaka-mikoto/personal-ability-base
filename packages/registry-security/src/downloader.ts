import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PabRegistryError } from "./errors.ts";
import { sha256Hex } from "./trust.ts";
import type { DownloadResult, PackageDownloader } from "./types.ts";

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/i;

/** Network adapter used by the store. Tests can replace it with MemoryPackageDownloader. */
export class FetchPackageDownloader implements PackageDownloader {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) { this.fetchImpl = fetchImpl; }

  async download(url: string, options: { signal?: AbortSignal; maxBytes?: number; expectedSha256?: string } = {}): Promise<DownloadResult> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: options.signal, redirect: "follow" });
    } catch (error) {
      throw new PabRegistryError("DOWNLOAD_FAILED", `Download failed: ${url}`, { url }, error);
    }
    if (!response.ok) throw new PabRegistryError("DOWNLOAD_FAILED", `Download returned HTTP ${response.status}`, { url, status: response.status });
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (announced > maxBytes) throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${maxBytes} bytes`, { url, announced, maxBytes });
    let bytes: Uint8Array;
    try {
      if (!response.body) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${maxBytes} bytes`, { url, maxBytes });
          }
          chunks.push(item.value);
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      }
    } catch (error) {
      if (error instanceof PabRegistryError) throw error;
      throw new PabRegistryError("DOWNLOAD_FAILED", `Unable to read package body: ${url}`, { url }, error);
    }
    if (bytes.byteLength > maxBytes) throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${maxBytes} bytes`, { url, maxBytes });
    if (options.expectedSha256 && sha256Hex(bytes) !== options.expectedSha256.toLowerCase()) {
      throw new PabRegistryError("HASH_MISMATCH", `Downloaded package hash does not match registry`, { url, expected: options.expectedSha256, actual: sha256Hex(bytes) });
    }
    return {
      bytes,
      url,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }
}

export class MemoryPackageDownloader implements PackageDownloader {
  private readonly packages: Record<string, Uint8Array | string>;

  constructor(packages: Record<string, Uint8Array | string>) { this.packages = packages; }

  async download(url: string, options: { expectedSha256?: string } = {}): Promise<DownloadResult> {
    const value = this.packages[url];
    if (value === undefined) throw new PabRegistryError("DOWNLOAD_FAILED", `No fixture registered for ${url}`, { url });
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    if (options.expectedSha256 && sha256Hex(bytes) !== options.expectedSha256.toLowerCase()) throw new PabRegistryError("HASH_MISMATCH", `Fixture hash mismatch for ${url}`, { url });
    return { bytes, url };
  }
}

/** Local/developer package adapter. It still enforces the same size/hash checks. */
export class FilePackageDownloader implements PackageDownloader {
  async download(url: string, options: { maxBytes?: number; expectedSha256?: string } = {}): Promise<DownloadResult> {
    // fileURLToPath handles Windows drive letters and percent-escaped paths;
    // plain local paths remain useful for developer/air-gapped registries.
    const path = url.startsWith("file:") ? fileURLToPath(url) : url;
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(path)); } catch (error) { throw new PabRegistryError("DOWNLOAD_FAILED", `Unable to read local package: ${path}`, { path }, error); }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (bytes.byteLength > maxBytes) throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${maxBytes} bytes`, { path, maxBytes });
    const actual = sha256Hex(bytes);
    if (options.expectedSha256 && actual !== options.expectedSha256.toLowerCase()) throw new PabRegistryError("HASH_MISMATCH", `Local package hash does not match registry`, { path, expected: options.expectedSha256, actual });
    return { bytes, url };
  }
}

/** Content-addressed package cache. A cache hit is accepted only when the requested digest matches. */
export class PackageCache {
  private readonly directory: string;

  constructor(directory: string) { this.directory = directory; }

  private path(hash: string): string {
    if (!HASH_RE.test(hash)) throw new PabRegistryError("HASH_MISMATCH", "Package cache key must be a SHA-256 digest", { hash });
    return join(this.directory, `${hash.toLowerCase()}.pkg`);
  }

  async get(expectedSha256: string): Promise<Uint8Array | undefined> {
    const hash = expectedSha256.toLowerCase();
    try {
      const bytes = new Uint8Array(await readFile(this.path(hash)));
      if (createHash("sha256").update(bytes).digest("hex") !== hash) return undefined;
      return bytes;
    } catch { return undefined; }
  }

  async put(bytes: Uint8Array, expectedSha256?: string): Promise<string> {
    const actual = sha256Hex(bytes);
    if (expectedSha256 && actual !== expectedSha256.toLowerCase()) throw new PabRegistryError("HASH_MISMATCH", "Refusing to cache package with unexpected hash", { expected: expectedSha256, actual });
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(actual);
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
    return actual;
  }

  async has(expectedSha256: string): Promise<boolean> { return (await this.get(expectedSha256)) !== undefined; }

  async size(expectedSha256: string): Promise<number | undefined> {
    try { return (await stat(this.path(expectedSha256))).size; } catch { return undefined; }
  }
}

export class CachedPackageDownloader implements PackageDownloader {
  private readonly cache: PackageCache;
  private readonly upstream: PackageDownloader;

  constructor(cache: PackageCache, upstream: PackageDownloader) {
    this.cache = cache;
    this.upstream = upstream;
  }

  async download(url: string, options: { signal?: AbortSignal; maxBytes?: number; expectedSha256?: string } = {}): Promise<DownloadResult> {
    if (options.expectedSha256) {
      const cached = await this.cache.get(options.expectedSha256);
      if (cached) {
        if (options.maxBytes !== undefined && cached.byteLength > options.maxBytes) throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${options.maxBytes} bytes`, { url, maxBytes: options.maxBytes });
        return { bytes: cached, url };
      }
    }
    const result = await this.upstream.download(url, options);
    if (options.maxBytes !== undefined && result.bytes.byteLength > options.maxBytes) throw new PabRegistryError("PACKAGE_TOO_LARGE", `Package exceeds ${options.maxBytes} bytes`, { url, maxBytes: options.maxBytes });
    await this.cache.put(result.bytes, options.expectedSha256);
    return result;
  }
}
