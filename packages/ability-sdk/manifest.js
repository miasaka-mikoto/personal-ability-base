/**
 * Manifest helpers shared by the SDK, CLI, and Core loader.
 * No third-party JSON-schema dependency is required at runtime.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export const PLATFORMS = Object.freeze([
  "windows",
  "android",
  "linux",
  "macos",
  "ios",
  "web"
]);

export const PERMISSIONS = Object.freeze([
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
  "filesystem.export"
]);

export const CONTRIBUTION_KEYS = Object.freeze([
  "pages",
  "commands",
  "cards",
  "searchProviders",
  "workflows",
  "settings"
]);

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(value) {
  return typeof value === "string" && VERSION_RE.test(value);
}

export function isAbilityId(value) {
  return typeof value === "string" && ID_RE.test(value) && value.length <= 128;
}

/**
 * Validate and normalize an Ability Manifest.
 *
 * The result is deterministic and safe to persist in the registry. Unknown
 * fields are retained (so newer Core versions can add fields) but malformed
 * required fields are rejected with structured errors.
 */
export function validateManifest(input, options = {}) {
  const errors = [];
  const manifest = input && typeof input === "object" ? input : {};
  const knownPlatforms = options.platforms ?? PLATFORMS;
  const knownPermissions = options.permissions ?? PERMISSIONS;

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push({ path: "schemaVersion", code: "schema_version", message: `Expected schemaVersion ${MANIFEST_SCHEMA_VERSION}.` });
  }
  if (!isAbilityId(manifest.id)) {
    errors.push({ path: "id", code: "id", message: "id must use lowercase reverse-DNS-like segments (for example com.pab.pocket-cortex)." });
  }
  for (const field of ["name", "displayName", "description", "author", "entry"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      errors.push({ path: field, code: "required", message: `${field} must be a non-empty string.` });
    }
  }
  if (!isSemver(manifest.version)) {
    errors.push({ path: "version", code: "version", message: "version must be semantic version (x.y.z)." });
  }
  if (!isSemver(manifest.minCoreVersion)) {
    errors.push({ path: "minCoreVersion", code: "min_core_version", message: "minCoreVersion must be semantic version (x.y.z)." });
  }
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) {
    errors.push({ path: "platforms", code: "required", message: "platforms must contain at least one target." });
  } else {
    for (const [index, platform] of manifest.platforms.entries()) {
      if (!knownPlatforms.includes(platform)) {
        errors.push({ path: `platforms[${index}]`, code: "platform", message: `Unsupported platform: ${String(platform)}.` });
      }
    }
  }
  if (!Array.isArray(manifest.permissions)) {
    errors.push({ path: "permissions", code: "required", message: "permissions must be an array (use [] when none are required)." });
  } else {
    for (const [index, permission] of manifest.permissions.entries()) {
      if (!knownPermissions.includes(permission) && !String(permission).startsWith("custom.")) {
        errors.push({ path: `permissions[${index}]`, code: "permission", message: `Unknown permission: ${String(permission)}.` });
      }
    }
  }
  for (const field of ["dependencies", "optionalDependencies", "conflicts"]) {
    if (manifest[field] === undefined) continue;
    if (!manifest[field] || typeof manifest[field] !== "object" || Array.isArray(manifest[field])) {
      errors.push({ path: field, code: "object", message: `${field} must be an object mapping Ability IDs to semver ranges.` });
    } else {
      for (const [id, range] of Object.entries(manifest[field])) {
        if (!isAbilityId(id)) errors.push({ path: `${field}.${id}`, code: "dependency_id", message: `Invalid dependency id: ${id}.` });
        if (typeof range !== "string" || range.trim() === "") errors.push({ path: `${field}.${id}`, code: "dependency_range", message: "Dependency range must be a non-empty semver range." });
      }
    }
  }
  if (manifest.contributes !== undefined) {
    if (!manifest.contributes || typeof manifest.contributes !== "object" || Array.isArray(manifest.contributes)) {
      errors.push({ path: "contributes", code: "object", message: "contributes must be an object." });
    } else {
      for (const key of CONTRIBUTION_KEYS) {
        if (manifest.contributes[key] !== undefined && !Array.isArray(manifest.contributes[key])) {
          errors.push({ path: `contributes.${key}`, code: "array", message: `${key} must be an array.` });
        }
      }
    }
  }
  if (manifest.entry && (manifest.entry.startsWith("/") || manifest.entry.includes(".."))) {
    errors.push({ path: "entry", code: "entry_path", message: "entry must be a package-relative path without traversal." });
  }
  if (manifest.integrity !== undefined) {
    if (!manifest.integrity || typeof manifest.integrity !== "object") errors.push({ path: "integrity", code: "object", message: "integrity must be an object." });
    else if (manifest.integrity.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(manifest.integrity.sha256)) errors.push({ path: "integrity.sha256", code: "sha256", message: "sha256 must be a 64-character hexadecimal digest." });
  }
  if (manifest.signature !== undefined) {
    if (!manifest.signature || typeof manifest.signature !== "object") errors.push({ path: "signature", code: "object", message: "signature must be an object." });
    else {
      for (const field of ["algorithm", "keyId", "value"]) if (typeof manifest.signature[field] !== "string" || manifest.signature[field].trim() === "") errors.push({ path: `signature.${field}`, code: "required", message: `${field} must be a non-empty string.` });
    }
  }

  const normalized = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: manifest.id,
    name: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    minCoreVersion: manifest.minCoreVersion,
    platforms: Array.isArray(manifest.platforms) ? [...new Set(manifest.platforms)] : [],
    permissions: Array.isArray(manifest.permissions) ? [...new Set(manifest.permissions)] : [],
    dependencies: { ...(manifest.dependencies ?? {}) },
    optionalDependencies: { ...(manifest.optionalDependencies ?? {}) },
    conflicts: { ...(manifest.conflicts ?? {}) },
    contributes: {
      pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [],
      ...(manifest.contributes ?? {})
    },
    entry: manifest.entry,
    ...(manifest.runtime ? { runtime: manifest.runtime } : {}),
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.source ? { source: manifest.source } : {}),
    ...(manifest.integrity ? { integrity: manifest.integrity } : {}),
    ...(manifest.signature ? { signature: manifest.signature } : {}),
    ...(manifest.migrations ? { migrations: manifest.migrations } : {}),
    ...(manifest.releaseNotes ? { releaseNotes: manifest.releaseNotes } : {})
  };
  return { valid: errors.length === 0, errors, manifest: normalized };
}

export function assertValidManifest(input, options) {
  const result = validateManifest(input, options);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.path}: ${error.message}`).join("\n");
    const exception = new Error(`Invalid Ability Manifest:\n${detail}`);
    exception.code = "PAB_INVALID_MANIFEST";
    exception.errors = result.errors;
    throw exception;
  }
  return result.manifest;
}

export function createManifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "com.pab.example.ability",
    name: "Example Ability",
    displayName: "示例能力",
    version: "0.1.0",
    description: "A Personal Ability Base module.",
    author: "Your Name",
    minCoreVersion: "0.1.0",
    platforms: ["windows", "android"],
    permissions: [],
    dependencies: {},
    optionalDependencies: {},
    conflicts: {},
    contributes: { pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [] },
    entry: "dist/index.js",
    runtime: { type: "pab-js", apiVersion: 1 },
    ...overrides
  };
}
