import { PabRegistryError } from "./errors.ts";
import { SemVer, satisfies, validVersion } from "./semver.ts";
import type { AbilityDependencyMap, AbilityManifest, Platform } from "./types.ts";

export const SUPPORTED_PLATFORMS: readonly Platform[] = ["windows", "android", "linux", "macos", "ios", "web"];
export const PERMISSION_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
export const KNOWN_PERMISSIONS: readonly string[] = [
  "storage.private", "storage.shared", "memory.read", "memory.write", "camera", "microphone",
  "location", "network", "clipboard", "notifications", "filesystem.import", "filesystem.export",
];
export const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;
const ID_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SAFE_ENTRY_RE = /^(?![A-Za-z]:)(?![\\/])(?:[^/\\.][^/\\]*\/)*[^/\\.][^/\\]*$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PabRegistryError("INVALID_MANIFEST", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new PabRegistryError("INVALID_MANIFEST", `${label} must be a non-empty string`);
  return value;
}

function dependencyMap(value: unknown, label: string): AbilityDependencyMap {
  if (value === undefined) return {};
  const raw = object(value, label);
  const output: AbilityDependencyMap = {};
  for (const [id, range] of Object.entries(raw)) {
    if (!ID_RE.test(id) || typeof range !== "string" || !range.trim() || !validRange(range)) throw new PabRegistryError("INVALID_MANIFEST", `Invalid dependency ${label}.${id}`);
    output[id] = range;
  }
  return output;
}

function validRange(range: string): boolean {
  try {
    satisfies("0.0.0", range);
    return true;
  } catch { return false; }
}

export function validateAbilityManifest(input: unknown): AbilityManifest {
  const raw = object(input, "manifest");
  if (typeof raw.schemaVersion !== "number" || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) throw new PabRegistryError("INVALID_MANIFEST", "manifest.schemaVersion must be a positive integer");
  if (raw.schemaVersion > SUPPORTED_MANIFEST_SCHEMA_VERSION) throw new PabRegistryError("INVALID_MANIFEST", `Unsupported manifest schemaVersion: ${raw.schemaVersion}`);
  const id = string(raw.id, "manifest.id")!;
  if (!ID_RE.test(id)) throw new PabRegistryError("INVALID_MANIFEST", `Invalid manifest.id: ${id}`);
  string(raw.name, "manifest.name");
  string(raw.displayName ?? raw.name, "manifest.displayName");
  string(raw.description, "manifest.description");
  string(raw.author, "manifest.author");
  const version = string(raw.version, "manifest.version")!;
  if (!validVersion(version)) throw new PabRegistryError("INVALID_MANIFEST", `Invalid manifest.version: ${version}`);
  const entry = string(raw.entry, "manifest.entry")!;
  if (!SAFE_ENTRY_RE.test(entry) || entry.split(/[\\/]/).includes("..")) throw new PabRegistryError("INVALID_MANIFEST", "manifest.entry must be a safe relative file path");
  const platforms = raw.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((item) => !SUPPORTED_PLATFORMS.includes(item as Platform))) throw new PabRegistryError("INVALID_MANIFEST", "manifest.platforms must contain supported platforms");
  const permissions = raw.permissions;
  if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== "string" || !PERMISSION_RE.test(item) || (!KNOWN_PERMISSIONS.includes(item) && !item.startsWith("custom.")))) throw new PabRegistryError("INVALID_MANIFEST", "manifest.permissions contains an invalid or unknown permission");
  const minCoreVersion = string(raw.minCoreVersion, "manifest.minCoreVersion")!;
  if (!validVersion(minCoreVersion)) throw new PabRegistryError("INVALID_MANIFEST", `Invalid manifest.minCoreVersion: ${minCoreVersion}`);
  const migrations = raw.migrations;
  if (migrations !== undefined) {
    if (!Array.isArray(migrations)) throw new PabRegistryError("INVALID_MANIFEST", "manifest.migrations must be an array");
    for (const migration of migrations) {
      const item = object(migration, "manifest.migrations[]");
      const from = string(item.from, "manifest.migrations[].from")!;
      const to = string(item.to, "manifest.migrations[].to")!;
      if (!validVersion(from) || !validVersion(to)) throw new PabRegistryError("INVALID_MANIFEST", "Migration versions must be semantic versions");
      if (item.entry !== undefined) {
        const migrationEntry = string(item.entry, "manifest.migrations[].entry")!;
        if (!SAFE_ENTRY_RE.test(migrationEntry) || migrationEntry.split(/[\\/]/).includes("..")) throw new PabRegistryError("INVALID_MANIFEST", "Migration entry must be a safe relative path");
      }
    }
  }
  const contributes = raw.contributes;
  const contributionObject = object(contributes, "manifest.contributes");
  for (const key of ["pages", "commands", "cards", "searchProviders", "workflows", "settings"]) {
    if (contributionObject[key] !== undefined && !Array.isArray(contributionObject[key])) throw new PabRegistryError("INVALID_MANIFEST", `manifest.contributes.${key} must be an array`);
  }
  if (raw.dependencies === undefined || raw.optionalDependencies === undefined) throw new PabRegistryError("INVALID_MANIFEST", "manifest.dependencies and manifest.optionalDependencies are required");
  if (raw.conflicts !== undefined) dependencyMap(raw.conflicts, "manifest.conflicts");
  return {
    ...raw,
    schemaVersion: raw.schemaVersion,
    id,
    version: new SemVer(version).toString(),
    entry,
    minCoreVersion: new SemVer(minCoreVersion).toString(),
    platforms: [...new Set(platforms as Platform[])],
    permissions: [...new Set(permissions as string[])],
    dependencies: dependencyMap(raw.dependencies, "manifest.dependencies"),
    optionalDependencies: dependencyMap(raw.optionalDependencies, "manifest.optionalDependencies"),
    conflicts: dependencyMap(raw.conflicts, "manifest.conflicts"),
  } as AbilityManifest;
}
