import { ErrorCode, PabError } from "./errors.js";
import { canonicalRange, normaliseVersion, parseVersion, satisfies } from "./semver.js";

export const MANIFEST_SCHEMA_VERSION = 1;
export const SUPPORTED_PLATFORMS = Object.freeze(["windows", "android", "linux", "macos", "ios", "web"]);
export const KNOWN_PERMISSIONS = Object.freeze([
  "storage.private",
  "storage.shared",
  "memory.read",
  "memory.write",
  "camera",
  "microphone",
  "location",
  "network",
  "clipboard",
  "notifications",
  "filesystem.import",
  "filesystem.export",
]);

const ID_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const CONTRIBUTION_KEYS = ["pages", "commands", "cards", "searchProviders", "workflows", "settings"];

/** @param {unknown} value @param {string} path @param {string[]} errors */
function requireString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string`);
}

/**
 * Validate and normalise an Ability manifest. The returned object is safe to
 * persist and can be used by both native shells without another schema pass.
 * @param {unknown} input
 * @param {{supportedSchemaVersions?: number[], knownPermissions?: string[]}} [options]
 */
export function validateManifest(input, options = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PabError(ErrorCode.INVALID_MANIFEST, "Ability manifest must be an object", { errors: ["manifest must be an object"] });
  }
  const value = /** @type {Record<string, any>} */ (input);
  const supportedSchemas = options.supportedSchemaVersions ?? [MANIFEST_SCHEMA_VERSION];
  if (!Number.isInteger(value.schemaVersion) || !supportedSchemas.includes(value.schemaVersion)) {
    errors.push(`schemaVersion must be one of ${supportedSchemas.join(", ")}`);
  }
  requireString(value.id, "id", errors);
  if (typeof value.id === "string" && !ID_RE.test(value.id)) errors.push("id must contain lowercase letters, numbers, dots and hyphens only");
  requireString(value.name, "name", errors);
  requireString(value.displayName ?? value.name, "displayName", errors);
  requireString(value.version, "version", errors);
  if (typeof value.version === "string") {
    try { parseVersion(value.version); } catch { errors.push("version must be valid semantic version"); }
  }
  requireString(value.entry, "entry", errors);
  if (typeof value.entry === "string" && (value.entry.startsWith("/") || value.entry.includes(".."))) {
    errors.push("entry must be a relative path inside the module package");
  }
  if (value.description !== undefined && typeof value.description !== "string") errors.push("description must be a string");
  if (value.minCoreVersion !== undefined && !validRange(value.minCoreVersion)) errors.push("minCoreVersion must be a valid semantic version range");
  const platforms = value.platforms ?? [];
  if (!Array.isArray(platforms) || !platforms.length) errors.push("platforms must contain at least one platform");
  else platforms.forEach((platform, index) => {
    if (typeof platform !== "string" || !SUPPORTED_PLATFORMS.includes(platform)) errors.push(`platforms[${index}] is unsupported`);
  });
  const permissions = value.permissions ?? [];
  if (!Array.isArray(permissions)) errors.push("permissions must be an array");
  else permissions.forEach((permission, index) => {
    if (typeof permission !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(permission)) errors.push(`permissions[${index}] is invalid`);
    const known = options.knownPermissions ?? KNOWN_PERMISSIONS;
    if (typeof permission === "string" && !known.includes(permission) && !permission.startsWith("custom.")) errors.push(`permissions[${index}] is not recognised`);
  });
  for (const field of ["dependencies", "optionalDependencies"]) {
    const dependencies = value[field] ?? {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) errors.push(`${field} must be an object`);
    else for (const [id, range] of Object.entries(dependencies)) {
      if (!ID_RE.test(id)) errors.push(`${field}.${id} has invalid module id`);
      if (typeof range !== "string" || !range.trim() || !validRange(range)) errors.push(`${field}.${id} must be a semver range`);
    }
  }
  const contributes = value.contributes ?? {};
  if (!contributes || typeof contributes !== "object" || Array.isArray(contributes)) errors.push("contributes must be an object");
  else for (const key of CONTRIBUTION_KEYS) {
    if (contributes[key] !== undefined && !Array.isArray(contributes[key])) errors.push(`contributes.${key} must be an array`);
  }
  if (value.migrations !== undefined) {
    if (!Array.isArray(value.migrations)) errors.push("migrations must be an array");
    else value.migrations.forEach((migration, index) => {
      if (!migration || typeof migration !== "object" || typeof migration.from !== "string" || typeof migration.to !== "string") errors.push(`migrations[${index}] must include from and to versions`);
      else if (!validRange(migration.from) || !validRange(migration.to)) errors.push(`migrations[${index}] has invalid version range`);
    });
  }
  if (errors.length) throw new PabError(ErrorCode.INVALID_MANIFEST, "Ability manifest validation failed", { errors });
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    id: value.id,
    name: value.name,
    displayName: value.displayName ?? value.name,
    version: normaliseVersion(value.version),
    description: value.description ?? "",
    author: value.author ?? "",
    minCoreVersion: canonicalRange(value.minCoreVersion ?? "0.0.0"),
    platforms: [...new Set(platforms)],
    permissions: [...new Set(permissions)],
    dependencies: { ...(value.dependencies ?? {}) },
    optionalDependencies: { ...(value.optionalDependencies ?? {}) },
    conflicts: { ...(value.conflicts ?? {}) },
    contributes: Object.fromEntries(CONTRIBUTION_KEYS.map((key) => [key, [...(contributes[key] ?? [])]])),
    entry: value.entry,
    icon: value.icon ?? undefined,
    repository: value.repository ?? undefined,
    source: value.source ?? undefined,
    runtime: value.runtime ?? undefined,
    integrity: value.integrity ?? undefined,
    migrations: Array.isArray(value.migrations) ? [...value.migrations] : [],
    releaseNotes: value.releaseNotes ?? undefined,
  });
}

function validRange(range) {
  if (typeof range !== "string" || !range.trim()) return false;
  try { satisfies("0.0.0", range); return true; } catch { return false; }
}

/** Check that a manifest can run on a target. */
export function assertManifestCompatible(manifest, { coreVersion, platform }) {
  const checked = validateManifest(manifest);
  const minRange = /^\d+(?:\.\d+){0,2}(?:[-+].*)?$/.test(checked.minCoreVersion)
    ? `>=${checked.minCoreVersion}`
    : checked.minCoreVersion;
  if (coreVersion && !satisfies(coreVersion, minRange)) {
    throw new PabError(ErrorCode.CORE_VERSION_TOO_OLD, `${checked.id} requires Core ${checked.minCoreVersion}`, { required: checked.minCoreVersion, actual: coreVersion });
  }
  if (platform && !checked.platforms.includes(platform)) {
    throw new PabError(ErrorCode.PLATFORM_UNSUPPORTED, `${checked.id} does not support ${platform}`, { platform, supported: checked.platforms });
  }
  return checked;
}
