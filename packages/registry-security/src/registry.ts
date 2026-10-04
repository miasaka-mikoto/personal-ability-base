import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PabRegistryError } from "./errors.ts";
import { SemVer, satisfies, validVersion } from "./semver.ts";
import { PERMISSION_RE, SUPPORTED_PLATFORMS } from "./manifest.ts";
import type { AbilityLoadoutEntry, AbilityPackEntry, AbilityRegistryEntry, CachedRegistry, RegistryCacheMeta, RegistryDocument } from "./types.ts";

const ID_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const SUPPORTED_REGISTRY_SCHEMA_VERSION = 1;

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PabRegistryError("INVALID_REGISTRY", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PabRegistryError("INVALID_REGISTRY", `${label} must be a non-empty string`, { field: label });
  }
  return value;
}

function assertStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const obj = assertObject(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (!ID_RE.test(key)) throw new PabRegistryError("INVALID_REGISTRY", `${label} contains invalid ability ID: ${key}`);
    const range = assertString(item, `${label}.${key}`)!;
    try { satisfies("0.0.0", range); } catch { throw new PabRegistryError("INVALID_REGISTRY", `Invalid semantic-version range in ${label}.${key}`); }
    output[key] = range;
  }
  return output;
}

/** Validate and normalize a registry before it is ever shown or used for installation. */
export function validateRegistry(input: unknown): RegistryDocument {
  const root = assertObject(input, "registry");
  if (typeof root.schemaVersion !== "number" || !Number.isInteger(root.schemaVersion) || root.schemaVersion < 1) {
    throw new PabRegistryError("INVALID_REGISTRY", "registry.schemaVersion must be a positive integer");
  }
  if (root.schemaVersion > SUPPORTED_REGISTRY_SCHEMA_VERSION) throw new PabRegistryError("INVALID_REGISTRY", `Unsupported registry schemaVersion: ${root.schemaVersion}`);
  if (!Array.isArray(root.abilities)) {
    throw new PabRegistryError("INVALID_REGISTRY", "registry.abilities must be an array");
  }
  const seen = new Set<string>();
  const abilities: AbilityRegistryEntry[] = root.abilities.map((raw, index) => {
    const entry = assertObject(raw, `registry.abilities[${index}]`);
    const entrySchemaVersion = entry.schemaVersion ?? root.schemaVersion;
    if (typeof entrySchemaVersion !== "number" || !Number.isInteger(entrySchemaVersion) || entrySchemaVersion !== SUPPORTED_REGISTRY_SCHEMA_VERSION) {
      throw new PabRegistryError("INVALID_REGISTRY", `Invalid schemaVersion for registry.abilities[${index}]`);
    }
    const id = assertString(entry.id, `registry.abilities[${index}].id`)!;
    const version = assertString(entry.version, `registry.abilities[${index}].version`)!;
    if (!ID_RE.test(id)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid ability ID: ${id}`, { id });
    if (!validVersion(version)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid ability version: ${version}`, { id, version });
    const key = `${id}@${new SemVer(version).toString()}`;
    if (seen.has(key)) throw new PabRegistryError("INVALID_REGISTRY", `Duplicate registry entry: ${key}`, { id, version });
    seen.add(key);
    const repository = assertString(entry.repository, `registry.abilities[${index}].repository`)!;
    const packageUrl = assertString(entry.packageUrl, `registry.abilities[${index}].packageUrl`)!;
    const sha256 = assertString(entry.sha256, `registry.abilities[${index}].sha256`)!;
    if (!SHA_RE.test(sha256)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid SHA-256 for ${id}@${version}`);
    const trust = assertString(entry.trust, `registry.abilities[${index}].trust`)!;
    if (!["official", "verified", "community", "local", "developer"].includes(trust)) {
      throw new PabRegistryError("INVALID_REGISTRY", `Invalid trust level for ${id}: ${trust}`);
    }
    const platforms = entry.platforms;
    if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((p) => typeof p !== "string" || !SUPPORTED_PLATFORMS.includes(p as any))) {
      throw new PabRegistryError("INVALID_REGISTRY", `platforms must contain at least one platform for ${id}`);
    }
    const minCoreVersion = assertString(entry.minCoreVersion, `registry.abilities[${index}].minCoreVersion`)!;
    if (!validVersion(minCoreVersion)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid minCoreVersion for ${id}`);
    const signature = entry.signature;
    if (signature !== undefined) {
      const sig = assertObject(signature, `registry.abilities[${index}].signature`);
      if (sig.algorithm !== "ed25519" || typeof sig.keyId !== "string" || typeof sig.value !== "string") {
        throw new PabRegistryError("INVALID_REGISTRY", `Invalid signature descriptor for ${id}@${version}`);
      }
      if (sig.signedPayload !== undefined && sig.signedPayload !== "package" && sig.signedPayload !== "sha256") {
        throw new PabRegistryError("INVALID_REGISTRY", `Invalid signature payload for ${id}@${version}`);
      }
    }
    const normalized: AbilityRegistryEntry = {
      ...entry,
      schemaVersion: entrySchemaVersion as number,
      id,
      name: assertString(entry.name, `registry.abilities[${index}].name`)!,
      displayName: assertString(entry.displayName, "displayName", false),
      version: new SemVer(version).toString(),
      repository,
      packageUrl,
      sha256: sha256.toLowerCase(),
      trust: trust as AbilityRegistryEntry["trust"],
      platforms: platforms as AbilityRegistryEntry["platforms"],
      permissions: Array.isArray(entry.permissions) ? entry.permissions.map((p) => {
        if (typeof p !== "string") throw new PabRegistryError("INVALID_REGISTRY", `Invalid permission declaration for ${id}`);
        return p;
      }) : [],
      dependencies: assertStringMap(entry.dependencies, "dependencies"),
      optionalDependencies: assertStringMap(entry.optionalDependencies, "optionalDependencies"),
      conflicts: assertStringMap(entry.conflicts, "conflicts"),
      minCoreVersion: new SemVer(minCoreVersion).toString(),
    };
    if (normalized.permissions?.some((permission) => !PERMISSION_RE.test(permission))) {
      throw new PabRegistryError("INVALID_REGISTRY", `Invalid permission declaration for ${id}`);
    }
    return normalized;
  });
  let packs: AbilityPackEntry[] | undefined;
  if (root.packs !== undefined) {
    if (!Array.isArray(root.packs)) throw new PabRegistryError("INVALID_REGISTRY", "registry.packs must be an array");
    const packIds = new Set<string>();
    packs = root.packs.map((raw, index) => {
      const pack = assertObject(raw, `registry.packs[${index}]`);
      const id = assertString(pack.id, `registry.packs[${index}].id`)!;
      const name = assertString(pack.name, `registry.packs[${index}].name`)!;
      if (!ID_RE.test(id) || packIds.has(id)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid or duplicate pack ID: ${id}`);
      packIds.add(id);
      if (!Array.isArray(pack.abilities) || pack.abilities.length === 0 || pack.abilities.some((abilityId) => typeof abilityId !== "string" || !ID_RE.test(abilityId))) {
        throw new PabRegistryError("INVALID_REGISTRY", `registry.packs[${index}].abilities must contain Ability IDs`);
      }
      return { ...pack, id, name, abilities: [...new Set(pack.abilities as string[])] };
    });
    const abilityIds = new Set(abilities.map((ability) => ability.id));
    for (const pack of packs) {
      const missing = pack.abilities.filter((abilityId) => !abilityIds.has(abilityId));
      if (missing.length) throw new PabRegistryError("INVALID_REGISTRY", `Pack ${pack.id} references unknown Abilities: ${missing.join(", ")}`);
    }
  }
  let loadouts: AbilityLoadoutEntry[] | undefined;
  if (root.loadouts !== undefined) {
    if (!Array.isArray(root.loadouts)) throw new PabRegistryError("INVALID_REGISTRY", "registry.loadouts must be an array");
    const loadoutIds = new Set<string>();
    loadouts = root.loadouts.map((raw, index) => {
      const loadout = assertObject(raw, `registry.loadouts[${index}]`);
      const id = assertString(loadout.id, `registry.loadouts[${index}].id`)!;
      const name = assertString(loadout.name, `registry.loadouts[${index}].name`)!;
      if (!ID_RE.test(id) || loadoutIds.has(id)) throw new PabRegistryError("INVALID_REGISTRY", `Invalid or duplicate loadout ID: ${id}`);
      loadoutIds.add(id);
      if (!Array.isArray(loadout.abilityIds) || loadout.abilityIds.length === 0 || loadout.abilityIds.some((abilityId) => typeof abilityId !== "string" || !ID_RE.test(abilityId))) {
        throw new PabRegistryError("INVALID_REGISTRY", `registry.loadouts[${index}].abilityIds must contain Ability IDs`);
      }
      if (loadout.default !== undefined && typeof loadout.default !== "boolean") {
        throw new PabRegistryError("INVALID_REGISTRY", `registry.loadouts[${index}].default must be boolean`);
      }
      if (loadout.order !== undefined && (!Number.isInteger(loadout.order) || (loadout.order as number) < 0)) {
        throw new PabRegistryError("INVALID_REGISTRY", `registry.loadouts[${index}].order must be a non-negative integer`);
      }
      return { ...loadout, id, name, abilityIds: [...new Set(loadout.abilityIds as string[])] } as AbilityLoadoutEntry;
    });
    const abilityIds = new Set(abilities.map((ability) => ability.id));
    for (const loadout of loadouts) {
      const missing = loadout.abilityIds.filter((abilityId) => !abilityIds.has(abilityId));
      if (missing.length) throw new PabRegistryError("INVALID_REGISTRY", `Loadout ${loadout.id} references unknown Abilities: ${missing.join(", ")}`);
    }
  }
  return { ...root, abilities, packs, loadouts } as RegistryDocument;
}

export function registrySha256(document: RegistryDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export interface RegistrySource {
  fetch(signal?: AbortSignal): Promise<{ document: RegistryDocument; etag?: string; lastModified?: string; sourceUrl?: string }>;
}

/** Fetches a registry JSON over HTTP. Kept behind the source interface for deterministic tests. */
export class HttpRegistrySource implements RegistrySource {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async fetch(signal?: AbortSignal): Promise<{ document: RegistryDocument; etag?: string; lastModified?: string; sourceUrl?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, { signal, headers: { accept: "application/json" } });
    } catch (error) {
      throw new PabRegistryError("REGISTRY_UNAVAILABLE", `Unable to fetch registry: ${this.url}`, { url: this.url }, error);
    }
    if (!response.ok) throw new PabRegistryError("REGISTRY_UNAVAILABLE", `Registry returned HTTP ${response.status}`, { url: this.url, status: response.status });
    let json: unknown;
    try { json = await response.json(); } catch (error) {
      throw new PabRegistryError("INVALID_REGISTRY", "Registry response is not valid JSON", { url: this.url }, error);
    }
    return { document: validateRegistry(json), etag: response.headers.get("etag") ?? undefined, lastModified: response.headers.get("last-modified") ?? undefined, sourceUrl: this.url };
  }
}

/** GitHub raw-content registry adapter; no GitHub SDK or account token is required. */
export class GitHubRegistrySource extends HttpRegistrySource {
  readonly owner: string;
  readonly repositoryName: string;
  readonly path: string;
  readonly ref: string;

  constructor(owner: string, repositoryName: string, path = "registry.json", ref = "main", fetchImpl: typeof fetch = fetch) {
    const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    super(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/${encodeURIComponent(ref)}/${encodedPath}`, fetchImpl);
    this.owner = owner;
    this.repositoryName = repositoryName;
    this.path = path;
    this.ref = ref;
  }
}

/** Local/developer registry source, useful for sideloading and air-gapped setups. */
export class FileRegistrySource implements RegistrySource {
  constructor(privatePath: string) { this.path = privatePath.startsWith("file:") ? fileURLToPath(privatePath) : privatePath; }
  private readonly path: string;

  async fetch(): Promise<{ document: RegistryDocument; sourceUrl?: string }> {
    try {
      const text = await readFile(this.path, "utf8");
      return { document: validateRegistry(JSON.parse(text)), sourceUrl: `file://${this.path}` };
    } catch (error) {
      if (error instanceof PabRegistryError) throw error;
      throw new PabRegistryError("REGISTRY_UNAVAILABLE", `Unable to read local registry: ${this.path}`, { path: this.path }, error);
    }
  }
}

export interface RegistryCacheOptions {
  maxAgeMs?: number;
  now?: () => Date;
}

/** Atomic, offline-first registry cache. A stale cache is still usable and is marked as stale. */
export class RegistryCacheStore {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly maxAgeMs: number;
  private readonly documentPath: string;
  private readonly metaPath: string;

  constructor(directory: string, options: RegistryCacheOptions = {}) {
    this.directory = directory;
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.documentPath = join(directory, "registry.json");
    this.metaPath = join(directory, "registry.meta.json");
  }

  async save(documentInput: unknown, details: { sourceUrl?: string; etag?: string; lastModified?: string } = {}): Promise<CachedRegistry> {
    const document = validateRegistry(documentInput);
    const fetchedAt = this.now().toISOString();
    const meta: RegistryCacheMeta = { ...details, fetchedAt, sha256: registrySha256(document), stale: false };
    await mkdir(this.directory, { recursive: true });
    await this.atomicWrite(this.documentPath, JSON.stringify(document, null, 2));
    await this.atomicWrite(this.metaPath, JSON.stringify(meta, null, 2));
    return { document, meta };
  }

  async load(options: { allowStale?: boolean } = {}): Promise<CachedRegistry | undefined> {
    let rawDocument: string;
    let rawMeta: string;
    try {
      [rawDocument, rawMeta] = await Promise.all([readFile(this.documentPath, "utf8"), readFile(this.metaPath, "utf8")]);
    } catch {
      return undefined;
    }
    let document: RegistryDocument;
    let meta: RegistryCacheMeta;
    try {
      document = validateRegistry(JSON.parse(rawDocument));
      meta = JSON.parse(rawMeta) as RegistryCacheMeta;
    } catch (error) {
      throw new PabRegistryError("INVALID_REGISTRY", "Registry cache is corrupt", { path: this.documentPath }, error);
    }
    if (!meta || typeof meta.sha256 !== "string" || meta.sha256.toLowerCase() !== registrySha256(document)) {
      throw new PabRegistryError("INVALID_REGISTRY", "Registry cache digest does not match registry contents", { path: this.documentPath });
    }
    if (!meta.fetchedAt || Number.isNaN(new Date(meta.fetchedAt).getTime())) {
      throw new PabRegistryError("INVALID_REGISTRY", "Registry cache metadata has an invalid fetchedAt timestamp", { path: this.metaPath });
    }
    const stale = this.now().getTime() - new Date(meta.fetchedAt).getTime() > this.maxAgeMs;
    if (stale && options.allowStale === false) return undefined;
    return { document, meta: { ...meta, stale } };
  }

  async refresh(source: RegistrySource, options: { signal?: AbortSignal; allowStaleOnError?: boolean } = {}): Promise<CachedRegistry> {
    try {
      const result = await source.fetch(options.signal);
      return await this.save(result.document, result);
    } catch (error) {
      if (options.allowStaleOnError !== false) {
        const cached = await this.load({ allowStale: true });
        if (cached) return { ...cached, meta: { ...cached.meta, stale: true } };
      }
      if (error instanceof PabRegistryError) throw error;
      throw new PabRegistryError("REGISTRY_UNAVAILABLE", "Registry refresh failed", {}, error);
    }
  }

  async clear(): Promise<void> {
    await Promise.all([rm(this.documentPath, { force: true }), rm(this.metaPath, { force: true })]);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  }
}
