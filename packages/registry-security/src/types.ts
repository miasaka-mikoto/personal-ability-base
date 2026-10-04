/** Public contracts shared by the PAB Core, Ability Store and module SDK. */

export type Platform = "windows" | "android" | "linux" | "macos" | "ios" | "web";

export type TrustLevel = "official" | "verified" | "community" | "local" | "developer";

export type PermissionMode = "allow" | "deny" | "ask";

export interface SignatureDescriptor {
  /** Signature algorithm. The first implementation intentionally only accepts Ed25519. */
  algorithm: "ed25519";
  /** ID in the trusted-key set shipped by Core (or explicitly added by the user). */
  keyId: string;
  /** Detached signature, encoded as base64 or base64url. */
  value: string;
  /** What was signed. Defaults to the package bytes. */
  signedPayload?: "package" | "sha256";
}

export interface AbilityDependencyMap {
  [abilityId: string]: string;
}

export interface AbilityRegistryEntry {
  schemaVersion: number;
  id: string;
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  icon?: string;
  category?: string;
  author?: string;
  repository: string;
  releaseUrl?: string;
  packageUrl: string;
  sha256: string;
  signature?: SignatureDescriptor;
  /** Official/verified/community/local/developer. */
  trust: TrustLevel;
  platforms: Platform[];
  permissions?: string[];
  dependencies?: AbilityDependencyMap;
  optionalDependencies?: AbilityDependencyMap;
  conflicts?: AbilityDependencyMap;
  minCoreVersion: string;
  releaseNotes?: string;
  screenshots?: string[];
  publishedAt?: string;
  /** Extra registry fields are retained for forward compatibility. */
  [key: string]: unknown;
}

export interface RegistryDocument {
  schemaVersion: number;
  generatedAt?: string;
  registryId?: string;
  abilities: AbilityRegistryEntry[];
  packs?: AbilityPackEntry[];
  /** Optional Core-provisioned focus presets; switching one never uninstalls modules. */
  loadouts?: AbilityLoadoutEntry[];
  publicKeys?: Record<string, string>;
  [key: string]: unknown;
}

export interface AbilityPackEntry {
  id: string;
  name: string;
  description?: string;
  abilities: string[];
  trust?: TrustLevel;
  [key: string]: unknown;
}

export interface AbilityLoadoutEntry {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  abilityIds: string[];
  default?: boolean;
  order?: number;
  [key: string]: unknown;
}

export interface RegistryCacheMeta {
  sourceUrl?: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
  sha256: string;
  stale: boolean;
}

export interface CachedRegistry {
  document: RegistryDocument;
  meta: RegistryCacheMeta;
}

export interface DownloadResult {
  bytes: Uint8Array;
  url: string;
  etag?: string;
  lastModified?: string;
  contentType?: string;
}

export interface PackageDownloader {
  download(url: string, options?: { signal?: AbortSignal; maxBytes?: number; expectedSha256?: string }): Promise<DownloadResult>;
}

export interface PackageExtractor {
  extract(bytes: Uint8Array, destination: string): Promise<void>;
}

export interface AbilityManifest {
  schemaVersion: number;
  id: string;
  name?: string;
  displayName?: string;
  version: string;
  description?: string;
  minCoreVersion?: string;
  platforms?: Platform[];
  permissions?: string[];
  dependencies?: AbilityDependencyMap;
  optionalDependencies?: AbilityDependencyMap;
  contributes?: Record<string, unknown>;
  entry: string;
  migrations?: AbilityMigration[];
  [key: string]: unknown;
}

export interface AbilityMigration {
  from: string;
  to: string;
  entry?: string;
  description?: string;
}

export interface InstalledAbilityState {
  id: string;
  activeVersion?: string;
  enabled: boolean;
  installedVersions: string[];
  previousVersions: string[];
  installedAt?: string;
  updatedAt?: string;
  disabledAt?: string;
  sourceTrust?: TrustLevel;
  dataRetained: boolean;
  /** Persisted update controls; absent in legacy state files means manual/no ignores. */
  updatePolicy?: UpdatePolicy;
}

export type UpdateMode = "automatic" | "manual";

export interface UpdatePolicy {
  mode: UpdateMode;
  /** If set, updates resolve this exact version until the pin is cleared. */
  pinnedVersion?: string;
  /** Versions ignored by automatic/manual update discovery. */
  ignoredVersions: string[];
}

export interface InstallOptions {
  platform: Platform;
  coreVersion: string;
  /** Require a user confirmation for permissions before extraction. */
  approvedPermissions?: string[];
  /** Existing version to preserve as rollback target. Defaults to active version. */
  keepVersions?: number;
  /** Do not activate after installation. */
  activate?: boolean;
  /** Explicitly allow a trust level that policy normally blocks. */
  allowUntrusted?: boolean;
}

export type InstallStage =
  | "discover"
  | "download"
  | "hash"
  | "signature"
  | "manifest"
  | "dependencies"
  | "permissions"
  | "extract"
  | "migration"
  | "register"
  | "activate"
  | "complete";

export interface InstallProgress {
  stage: InstallStage;
  percent?: number;
  message: string;
}

export interface InstallResult {
  id: string;
  version: string;
  activated: boolean;
  path: string;
  stages: InstallProgress[];
  warnings: string[];
}

export interface DependencyResolution {
  requested: Record<string, string>;
  selected: Record<string, AbilityRegistryEntry>;
  order: string[];
  optionalSkipped: Array<{ id: string; range: string; reason: string }>;
}

export interface TrustPolicyOptions {
  allowedLevels?: TrustLevel[];
  requireSignatureFor?: TrustLevel[];
  trustedKeys?: Record<string, string | Uint8Array>;
  allowUnsignedLocal?: boolean;
}

export interface PackageVerificationResult {
  sha256: string;
  hashValid: boolean;
  signatureRequired: boolean;
  signatureValid: boolean;
  trustAllowed: boolean;
  warnings: string[];
}
