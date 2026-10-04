import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DependencyResolver } from "./dependencies.ts";
import { PabRegistryError } from "./errors.ts";
import { ZipPackageExtractor } from "./archive.ts";
import { assertPermissions, TrustPolicy } from "./trust.ts";
import { SemVer, compareVersions, satisfies, validVersion } from "./semver.ts";
import { validateAbilityManifest } from "./manifest.ts";
import type {
  AbilityManifest,
  AbilityRegistryEntry,
  DependencyResolution,
  InstallOptions,
  InstallProgress,
  InstallResult,
  InstalledAbilityState,
  PackageDownloader,
  PackageExtractor,
  Platform,
  RegistryDocument,
  UpdateMode,
  UpdatePolicy,
} from "./types.ts";

export interface MigrationContext {
  id: string;
  fromVersion?: string;
  toVersion: string;
  dataDirectory: string;
  moduleDirectory: string;
  migrations: NonNullable<AbilityManifest["migrations"]>;
}

export type MigrationRunner = (context: MigrationContext) => Promise<void>;

export interface ModuleStoreOptions {
  root: string;
  userDataRoot?: string;
  migrationRunner?: MigrationRunner;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new PabRegistryError("INSTALL_FAILED", `Unsafe ${label}: ${value}`);
  return value;
}

function assertWithin(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes("\0")) throw new PabRegistryError("INSTALL_FAILED", "Path escapes module store", { root, target });
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

const DEFAULT_UPDATE_POLICY: UpdatePolicy = { mode: "manual", ignoredVersions: [] };

function normalizeUpdatePolicy(value: unknown): UpdatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_UPDATE_POLICY };
  const raw = value as Record<string, unknown>;
  const mode: UpdateMode = raw.mode === "automatic" ? "automatic" : "manual";
  const pinnedVersion = typeof raw.pinnedVersion === "string" && validVersion(raw.pinnedVersion) ? new SemVer(raw.pinnedVersion).toString() : undefined;
  const ignoredVersions = Array.isArray(raw.ignoredVersions)
    ? [...new Set(raw.ignoredVersions.filter((item): item is string => typeof item === "string" && validVersion(item)).map((item) => new SemVer(item).toString()))].filter((item) => item !== pinnedVersion)
    : [];
  return pinnedVersion ? { mode, pinnedVersion, ignoredVersions } : { mode, ignoredVersions };
}

/** Versioned module filesystem. Module code and user data are intentionally separate roots. */
export class ModuleStore {
  readonly root: string;
  readonly modulesRoot: string;
  readonly stateRoot: string;
  readonly stagingRoot: string;
  readonly userDataRoot: string;
  private readonly migrationRunner?: MigrationRunner;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: ModuleStoreOptions) {
    this.root = options.root;
    this.modulesRoot = join(options.root, "modules");
    this.stateRoot = join(options.root, "state");
    this.stagingRoot = join(options.root, ".staging");
    this.userDataRoot = options.userDataRoot ?? join(options.root, "userdata");
    this.migrationRunner = options.migrationRunner;
  }

  async initialize(): Promise<void> { await Promise.all([mkdir(this.modulesRoot, { recursive: true }), mkdir(this.stateRoot, { recursive: true }), mkdir(this.stagingRoot, { recursive: true }), mkdir(this.userDataRoot, { recursive: true })]); }

  modulePath(id: string, version: string): string { return join(this.modulesRoot, safeSegment(id, "ability ID"), safeSegment(version, "version")); }
  dataPath(id: string): string { return join(this.userDataRoot, "abilities", safeSegment(id, "ability ID")); }
  private statePath(id: string): string { return join(this.stateRoot, `${safeSegment(id, "ability ID")}.json`); }

  async getState(id: string): Promise<InstalledAbilityState | undefined> {
    try {
      const state = JSON.parse(await readFile(this.statePath(id), "utf8")) as InstalledAbilityState;
      state.updatePolicy = normalizeUpdatePolicy(state.updatePolicy);
      return state;
    } catch { return undefined; }
  }

  async hasUserData(id: string): Promise<boolean> { return exists(this.dataPath(id)); }

  async getUpdatePolicy(id: string): Promise<UpdatePolicy> {
    const state = await this.requireState(id);
    return { ...(state.updatePolicy ?? DEFAULT_UPDATE_POLICY), ignoredVersions: [...(state.updatePolicy?.ignoredVersions ?? [])] };
  }

  async setUpdatePolicy(id: string, policy: Partial<UpdatePolicy>): Promise<InstalledAbilityState> {
    const state = await this.requireState(id);
    const mode = policy.mode ?? state.updatePolicy?.mode ?? DEFAULT_UPDATE_POLICY.mode;
    if (mode !== "automatic" && mode !== "manual") throw new PabRegistryError("INVALID_UPDATE_POLICY", `Unknown update mode: ${String(mode)}`, { id, mode });
    let pinnedVersion: string | undefined;
    const pinProvided = Object.prototype.hasOwnProperty.call(policy, "pinnedVersion");
    if (pinProvided && policy.pinnedVersion !== undefined && policy.pinnedVersion !== null) {
      if (!validVersion(policy.pinnedVersion)) throw new PabRegistryError("INVALID_UPDATE_POLICY", `Pinned version is not valid SemVer: ${policy.pinnedVersion}`, { id, pinnedVersion: policy.pinnedVersion });
      pinnedVersion = new SemVer(policy.pinnedVersion).toString();
    } else if (!pinProvided && state.updatePolicy?.pinnedVersion) {
      pinnedVersion = state.updatePolicy.pinnedVersion;
    }
    const rawIgnored = policy.ignoredVersions ?? state.updatePolicy?.ignoredVersions ?? [];
    if (!Array.isArray(rawIgnored) || rawIgnored.some((version) => typeof version !== "string" || !validVersion(version))) {
      throw new PabRegistryError("INVALID_UPDATE_POLICY", "Ignored versions must be semantic versions", { id, ignoredVersions: rawIgnored });
    }
    const ignoredVersions = [...new Set(rawIgnored.map((version) => new SemVer(version).toString()))];
    if (pinnedVersion && ignoredVersions.includes(pinnedVersion)) {
      throw new PabRegistryError("INVALID_UPDATE_POLICY", `Pinned version cannot also be ignored: ${pinnedVersion}`, { id, pinnedVersion });
    }
    state.updatePolicy = pinnedVersion ? { mode, pinnedVersion, ignoredVersions } : { mode, ignoredVersions };
    state.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  async setUpdateMode(id: string, mode: UpdateMode): Promise<InstalledAbilityState> { return this.setUpdatePolicy(id, { mode }); }

  async pinVersion(id: string, version: string | undefined): Promise<InstalledAbilityState> {
    return this.setUpdatePolicy(id, { pinnedVersion: version });
  }

  async ignoreVersion(id: string, version: string): Promise<InstalledAbilityState> {
    const policy = await this.getUpdatePolicy(id);
    return this.setUpdatePolicy(id, { ignoredVersions: [...policy.ignoredVersions, version] });
  }

  async unignoreVersion(id: string, version: string): Promise<InstalledAbilityState> {
    if (!validVersion(version)) throw new PabRegistryError("INVALID_UPDATE_POLICY", `Ignored version is not valid SemVer: ${version}`, { id, version });
    const normalized = new SemVer(version).toString();
    const policy = await this.getUpdatePolicy(id);
    return this.setUpdatePolicy(id, { ignoredVersions: policy.ignoredVersions.filter((item) => item !== normalized) });
  }

  async listInstalled(): Promise<InstalledAbilityState[]> {
    let names: string[];
    try { names = await readdir(this.stateRoot); } catch { return []; }
    const result: InstalledAbilityState[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const state = JSON.parse(await readFile(join(this.stateRoot, name), "utf8")) as InstalledAbilityState;
        state.updatePolicy = normalizeUpdatePolicy(state.updatePolicy);
        result.push(state);
      } catch { /* ignore corrupt state; diagnostics can report it */ }
    }
    return result;
  }

  async installExtracted(id: string, version: string, extractedPath: string, manifest: AbilityManifest, options: { activate?: boolean; sourceTrust?: InstalledAbilityState["sourceTrust"]; keepVersions?: number; warnings?: string[] } = {}): Promise<InstallResult> {
    await this.initialize();
    const target = this.modulePath(id, version);
    assertWithin(this.modulesRoot, target);
    const prior = await this.getState(id);
    const now = new Date().toISOString();
    const warnings = options.warnings ?? [];
    if (!prior && await this.hasUserData(id)) warnings.push("Previous user data found; it was retained and is available to restore.");
    // A disabled ability stays disabled across updates unless the caller
    // explicitly requests activation. Fresh installs activate by default.
    const activate = options.activate ?? (prior ? prior.enabled : true);
    const shouldMigrate = prior?.activeVersion && prior.activeVersion !== version && manifest.migrations?.length;
    if (shouldMigrate) {
      if (this.migrationRunner) {
        try {
          await this.migrationRunner({ id, fromVersion: prior.activeVersion, toVersion: version, dataDirectory: this.dataPath(id), moduleDirectory: extractedPath, migrations: manifest.migrations! });
        } catch (error) {
          throw new PabRegistryError("MIGRATION_FAILED", `Migration failed for ${id} ${prior.activeVersion} → ${version}`, { id, from: prior.activeVersion, to: version }, error);
        }
      } else warnings.push("Migration metadata is present but no migration runner is configured; user data was retained without migration.");
    }
    let installedVersion = await exists(target);
    if (!installedVersion) {
      await mkdir(dirname(target), { recursive: true });
      await rename(extractedPath, target);
      installedVersion = true;
    } else {
      await rm(extractedPath, { recursive: true, force: true });
    }
    const installedVersions = new Set(prior?.installedVersions ?? []);
    installedVersions.add(version);
    const previousVersions = new Set(prior?.previousVersions ?? []);
    if (prior?.activeVersion && prior.activeVersion !== version) previousVersions.add(prior.activeVersion);
    const keep = Math.max(0, options.keepVersions ?? 2);
    const sortedPrevious = [...previousVersions].sort((a, b) => compareVersions(b, a));
    const retainedPrevious = sortedPrevious.slice(0, keep);
    const state: InstalledAbilityState = {
      id,
      activeVersion: version,
      enabled: activate,
      installedVersions: [...installedVersions].sort(compareVersions),
      previousVersions: retainedPrevious,
      installedAt: prior?.installedAt ?? now,
      updatedAt: now,
      sourceTrust: options.sourceTrust ?? prior?.sourceTrust,
      dataRetained: true,
      updatePolicy: prior?.updatePolicy ?? { ...DEFAULT_UPDATE_POLICY },
    };
    await this.writeState(state);
    return { id, version, activated: Boolean(activate), path: target, stages: [], warnings };
  }

  async enable(id: string): Promise<InstalledAbilityState> {
    const state = await this.requireState(id);
    state.enabled = true;
    state.disabledAt = undefined;
    await this.writeState(state);
    return state;
  }

  async disable(id: string): Promise<InstalledAbilityState> {
    const state = await this.requireState(id);
    state.enabled = false;
    state.disabledAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  async rollback(id: string, version?: string): Promise<InstalledAbilityState> {
    const state = await this.requireState(id);
    const candidate = version ?? state.previousVersions[0];
    if (!candidate || !state.installedVersions.includes(candidate) || !(await exists(this.modulePath(id, candidate)))) {
      throw new PabRegistryError("ROLLBACK_FAILED", `No installed rollback version for ${id}`, { id, version: candidate });
    }
    if (state.activeVersion && state.activeVersion !== candidate) state.previousVersions = [state.activeVersion, ...state.previousVersions.filter((item) => item !== candidate)];
    state.activeVersion = candidate;
    state.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  async uninstall(id: string, options: { removeData?: boolean } = {}): Promise<void> {
    const state = await this.requireState(id);
    await rm(join(this.modulesRoot, safeSegment(id, "ability ID")), { recursive: true, force: true });
    await rm(this.statePath(id), { force: true });
    if (options.removeData) await rm(this.dataPath(id), { recursive: true, force: true });
    // By default data remains untouched and can be restored after reinstall.
    void state;
  }

  async repair(id: string): Promise<InstalledAbilityState> {
    const state = await this.requireState(id);
    const valid: string[] = [];
    for (const version of state.installedVersions) if (await exists(this.modulePath(id, version))) valid.push(version);
    if (state.activeVersion && !valid.includes(state.activeVersion)) throw new PabRegistryError("INSTALL_FAILED", `Active module files are missing for ${id}@${state.activeVersion}`, { id, version: state.activeVersion });
    state.installedVersions = valid;
    state.previousVersions = state.previousVersions.filter((version) => valid.includes(version));
    await this.writeState(state);
    return state;
  }

  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(id, queued);
    await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id); }
  }

  private async requireState(id: string): Promise<InstalledAbilityState> {
    const state = await this.getState(id);
    if (!state) throw new PabRegistryError("NOT_INSTALLED", `Ability is not installed: ${id}`, { id });
    return state;
  }

  private async writeState(state: InstalledAbilityState): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true });
    const path = this.statePath(state.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, path);
  }
}

export interface AbilityInstallerOptions {
  store: ModuleStore;
  downloader: PackageDownloader;
  extractor?: PackageExtractor;
  trustPolicy?: TrustPolicy;
  maxPackageBytes?: number;
  onProgress?: (progress: InstallProgress) => void;
}

/** Performs the discover → download → verify → extract → register → activate flow. */
export class AbilityInstaller {
  private readonly options: AbilityInstallerOptions;
  private readonly extractor: PackageExtractor;
  private readonly trustPolicy: TrustPolicy;
  private readonly maxPackageBytes: number;
  private readonly onProgress?: (progress: InstallProgress) => void;

  constructor(options: AbilityInstallerOptions) {
    this.options = options;
    this.extractor = options.extractor ?? new ZipPackageExtractor();
    this.trustPolicy = options.trustPolicy ?? new TrustPolicy();
    this.maxPackageBytes = options.maxPackageBytes ?? 256 * 1024 * 1024;
    this.onProgress = options.onProgress;
  }

  async install(entry: AbilityRegistryEntry, installOptions: InstallOptions): Promise<InstallResult> {
    const stages: InstallProgress[] = [];
    const progress = (stage: InstallProgress["stage"], message: string, percent?: number) => { const item = { stage, message, percent }; stages.push(item); this.onProgress?.(item); };
    await this.options.store.initialize();
    return this.options.store.withLock(entry.id, async () => {
      progress("discover", `Preparing ${entry.name} ${entry.version}`);
      if (!entry.platforms.includes(installOptions.platform)) throw new PabRegistryError("PLATFORM_UNSUPPORTED", `${entry.id} does not support ${installOptions.platform}`, { id: entry.id, platform: installOptions.platform });
      if (!satisfies(installOptions.coreVersion, `>=${entry.minCoreVersion}`)) throw new PabRegistryError("CORE_VERSION_UNSUPPORTED", `${entry.id} requires Core ${entry.minCoreVersion}`, { id: entry.id, minCoreVersion: entry.minCoreVersion, coreVersion: installOptions.coreVersion });
      if (!this.trustPolicy.isAllowed(entry.trust, installOptions.allowUntrusted)) throw new PabRegistryError("TRUST_BLOCKED", `Source trust level is not allowed: ${entry.trust}`, { id: entry.id, trust: entry.trust });
      progress("permissions", "Checking requested permissions");
      assertPermissions(entry.permissions, installOptions.approvedPermissions);
      progress("download", `Downloading ${entry.packageUrl}`, 0);
      const downloaded = await this.options.downloader.download(entry.packageUrl, { maxBytes: this.maxPackageBytes, expectedSha256: entry.sha256 });
      progress("download", "Package downloaded", 100);
      progress("hash", "Verifying SHA-256");
      const verification = this.trustPolicy.assertAllowed(entry, downloaded.bytes, installOptions.allowUntrusted);
      progress("hash", `SHA-256 verified: ${verification.sha256}`);
      if (verification.signatureRequired) progress("signature", "Signature verified");
      else progress("signature", "Signature check not required for this source");
      const staging = join(this.options.store.stagingRoot, `${safeSegment(entry.id, "ability ID")}-${safeSegment(entry.version, "version")}-${randomUUID()}`);
      await mkdir(staging, { recursive: true });
      try {
        progress("extract", "Installing package files");
        await this.extractor.extract(downloaded.bytes, staging);
        progress("manifest", "Validating module manifest");
        const manifest = await this.readManifest(staging, entry);
        progress("migration", "Checking data migration");
        const result = await this.options.store.installExtracted(entry.id, entry.version, staging, manifest, { activate: installOptions.activate, sourceTrust: entry.trust, keepVersions: installOptions.keepVersions });
        result.stages = stages.concat({ stage: "register", message: "Contributions registered" }, ...(result.activated ? [{ stage: "activate", message: "Ability activated" } as InstallProgress] : []), { stage: "complete", message: "Installation complete" });
        return result;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        if (error instanceof PabRegistryError) throw error;
        throw new PabRegistryError("INSTALL_FAILED", `Installation failed for ${entry.id}@${entry.version}`, { id: entry.id, version: entry.version }, error);
      }
    });
  }

  private async readManifest(staging: string, entry: AbilityRegistryEntry): Promise<AbilityManifest> {
    const path = join(staging, "manifest.json");
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("manifest.json is not a regular file");
      const manifest = validateAbilityManifest(JSON.parse(await readFile(path, "utf8")));
      if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error("manifest ID/version does not match registry");
      const registryPermissions = new Set(entry.permissions ?? []);
      const undeclaredPermissions = (manifest.permissions ?? []).filter((permission) => !registryPermissions.has(permission));
      if (undeclaredPermissions.length) throw new Error(`manifest requests permissions not declared by registry: ${undeclaredPermissions.join(", ")}`);
      // The registry may intentionally publish a subset of a portable
      // package's supported platforms. The installer already checks the
      // current platform against the registry entry; a broader manifest is
      // not a privilege escalation and must not reject a valid release.
      const sameMap = (left: Record<string, string> = {}, right: Record<string, string> = {}): boolean => JSON.stringify(Object.fromEntries(Object.entries(left).sort())) === JSON.stringify(Object.fromEntries(Object.entries(right).sort()));
      if (!sameMap(manifest.dependencies, entry.dependencies ?? {}) || !sameMap(manifest.optionalDependencies, entry.optionalDependencies ?? {})) throw new Error("manifest dependencies do not match registry metadata");
      const entryPath = resolve(staging, manifest.entry);
      assertWithin(staging, entryPath);
      const entryInfo = await lstat(entryPath);
      if (!entryInfo.isFile()) throw new Error("manifest entry is not a regular file");
      return manifest;
    } catch (error) {
      if (error instanceof PabRegistryError) throw error;
      throw new PabRegistryError("INVALID_MANIFEST", `Invalid manifest for ${entry.id}@${entry.version}`, { id: entry.id, version: entry.version }, error);
    }
  }
}

/** Installs a resolved graph in dependency-first order, then activates the requested roots. */
export class AbilityInstallCoordinator {
  private readonly installer: AbilityInstaller;
  private readonly resolver: DependencyResolver;

  constructor(installer: AbilityInstaller, resolver: DependencyResolver) {
    this.installer = installer;
    this.resolver = resolver;
  }

  async install(requested: Record<string, string>, options: InstallOptions): Promise<{ resolution: DependencyResolution; results: InstallResult[] }> {
    const resolution = this.resolver.resolve(requested);
    const results: InstallResult[] = [];
    for (const id of resolution.order) {
      const entry = resolution.selected[id];
      results.push(await this.installer.install(entry, { ...options, activate: requested[id] !== undefined ? options.activate : false }));
    }
    return { resolution, results };
  }
}
