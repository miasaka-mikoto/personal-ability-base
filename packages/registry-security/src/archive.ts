import { inflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { PabRegistryError } from "./errors.ts";
import type { PackageExtractor } from "./types.ts";

const U16 = (bytes: Uint8Array, offset: number): number => bytes[offset] | (bytes[offset + 1] << 8);
const U32 = (bytes: Uint8Array, offset: number): number => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeRelativePath(raw: string): string {
  const value = raw.replaceAll("\\", "/");
  if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new PabRegistryError("PATH_TRAVERSAL", `Unsafe package path: ${raw}`, { path: raw });
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) throw new PabRegistryError("PATH_TRAVERSAL", `Unsafe package path: ${raw}`, { path: raw });
  const normalized = normalize(value).replaceAll(sep, "/");
  if (normalized === ".." || normalized.startsWith("../")) throw new PabRegistryError("PATH_TRAVERSAL", `Unsafe package path: ${raw}`, { path: raw });
  return normalized;
}

function assertInside(destination: string, target: string): void {
  const rel = relative(destination, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes("\0")) throw new PabRegistryError("PATH_TRAVERSAL", `Package path escapes install directory`, { target });
}

/**
 * Minimal ZIP reader for Ability release packages. It supports stored and deflate
 * entries, rejects encrypted/symlink/path-traversal entries and verifies CRC32.
 */
export class ZipPackageExtractor implements PackageExtractor {
  private readonly maxUncompressedBytes: number;
  private readonly maxEntries: number;

  constructor(maxUncompressedBytes = 512 * 1024 * 1024, maxEntries = 10000) {
    this.maxUncompressedBytes = maxUncompressedBytes;
    this.maxEntries = maxEntries;
  }

  async extract(input: Uint8Array, destination: string): Promise<void> {
    const bytes = new Uint8Array(input);
    const eocd = this.findEocd(bytes);
    if (eocd < 0) throw new PabRegistryError("ARCHIVE_INVALID", "Package is not a ZIP archive");
    const centralSize = U32(bytes, eocd + 12);
    const centralOffset = U32(bytes, eocd + 16);
    if (centralOffset + centralSize > bytes.length) throw new PabRegistryError("ARCHIVE_INVALID", "ZIP central directory is truncated");
    let cursor = centralOffset;
    const end = centralOffset + centralSize;
    let entries = 0;
    let totalUncompressed = 0;
    await mkdir(destination, { recursive: true });
    while (cursor < end) {
      entries += 1;
      if (entries > this.maxEntries) throw new PabRegistryError("ARCHIVE_INVALID", `ZIP contains more than ${this.maxEntries} entries`);
      if (U32(bytes, cursor) !== 0x02014b50) throw new PabRegistryError("ARCHIVE_INVALID", "Invalid ZIP central directory entry");
      const flags = U16(bytes, cursor + 8);
      const method = U16(bytes, cursor + 10);
      const crc = U32(bytes, cursor + 16);
      const compressedSize = U32(bytes, cursor + 20);
      const uncompressedSize = U32(bytes, cursor + 24);
      const filenameLength = U16(bytes, cursor + 28);
      const extraLength = U16(bytes, cursor + 30);
      const commentLength = U16(bytes, cursor + 32);
      const externalAttrs = U32(bytes, cursor + 38);
      const localOffset = U32(bytes, cursor + 42);
      const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLength));
      cursor += 46 + filenameLength + extraLength + commentLength;
      if (flags & 1) throw new PabRegistryError("ARCHIVE_INVALID", `Encrypted ZIP entries are not supported: ${name}`);
      // Unix external file type 0120000 indicates symlink; never materialize links from a package.
      if (((externalAttrs >>> 16) & 0xf000) === 0xa000) throw new PabRegistryError("ARCHIVE_INVALID", `Symlink entries are not allowed: ${name}`);
      const safeName = safeRelativePath(name);
      const target = join(destination, safeName);
      assertInside(destination, target);
      if (name.endsWith("/")) { await mkdir(target, { recursive: true }); continue; }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > this.maxUncompressedBytes) throw new PabRegistryError("ARCHIVE_INVALID", `ZIP expands beyond ${this.maxUncompressedBytes} bytes`);
      if (U32(bytes, localOffset) !== 0x04034b50) throw new PabRegistryError("ARCHIVE_INVALID", `Invalid local ZIP header: ${name}`);
      const localNameLength = U16(bytes, localOffset + 26);
      const localExtraLength = U16(bytes, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) throw new PabRegistryError("ARCHIVE_INVALID", `ZIP entry is truncated: ${name}`);
      const compressed = bytes.subarray(dataStart, dataEnd);
      let content: Uint8Array;
      if (method === 0) content = new Uint8Array(compressed);
      else if (method === 8) content = new Uint8Array(inflateRawSync(compressed));
      else throw new PabRegistryError("ARCHIVE_INVALID", `Unsupported ZIP compression method ${method}: ${name}`);
      if (content.byteLength !== uncompressedSize || crc32(content) !== crc) throw new PabRegistryError("ARCHIVE_INVALID", `ZIP entry integrity check failed: ${name}`);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
  }

  private findEocd(bytes: Uint8Array): number {
    const start = Math.max(0, bytes.length - 22 - 0xffff);
    for (let offset = bytes.length - 22; offset >= start; offset -= 1) if (U32(bytes, offset) === 0x06054b50) return offset;
    return -1;
  }
}

/** A deterministic package adapter useful for development fixtures and local tests. */
export class JsonPackageExtractor implements PackageExtractor {
  async extract(input: Uint8Array, destination: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(input)); } catch (error) { throw new PabRegistryError("ARCHIVE_INVALID", "Package is not valid JSON fixture", {}, error); }
    if (!parsed || typeof parsed !== "object" || !("files" in parsed)) throw new PabRegistryError("ARCHIVE_INVALID", "JSON package must contain files");
    const files = (parsed as { files: Record<string, string> }).files;
    for (const [rawName, value] of Object.entries(files)) {
      const safeName = safeRelativePath(rawName);
      const target = join(destination, safeName);
      assertInside(destination, target);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, value, { flag: "wx" });
    }
  }
}
