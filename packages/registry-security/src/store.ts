import { DependencyResolver } from "./dependencies.ts";
import { PabRegistryError } from "./errors.ts";
import { AbilityInstaller, AbilityInstallCoordinator, ModuleStore } from "./installer.ts";
import { RegistryCacheStore } from "./registry.ts";
import { compareVersions, satisfies } from "./semver.ts";
import type {
  AbilityPackEntry,
  AbilityRegistryEntry,
  CachedRegistry,
  InstallOptions,
  InstallResult,
  Platform,
  RegistryDocument,
  RegistrySource,
  UpdateMode,
  UpdatePolicy,
} from "./types.ts";

export interface GitHubAbilityStoreOptions {
  cache: RegistryCacheStore;
  source: RegistrySource;
  installer: AbilityInstaller;
  moduleStore: ModuleStore;
  platform: Platform;
  coreVersion: string;
}

export interface StoreQuery {
  platform?: Platform;
  trust?: AbilityRegistryEntry["trust"][];
  category?: string;
}

export interface UpdateOptions extends InstallOptions {
  refresh?: boolean;
  /** Explicitly bypass manual mode, ignored versions and pins for this run. */
  force?: boolean;
  /** Automatic triggers respect the persisted mode; manual triggers always run. */
  trigger?: "automatic" | "manual";
  range?: string;
}

export type UpdateSkipReason = "manual-required" | "ignored" | "up-to-date";

export interface UpdateResult {
  entry: AbilityRegistryEntry;
  results: InstallResult[];
  updated: boolean;
  skipped?: UpdateSkipReason;
}

/**
 * User-facing Ability Store facade. It deliberately has no GitHub SDK state:
 * GitHub is represented by the injected RegistrySource and package downloader,
 * making offline behavior and tests deterministic.
 */
export class GitHubAbilityStore {
  private readonly options: GitHubAbilityStoreOptions;
  private snapshot?: CachedRegistry;

  constructor(options: GitHubAbilityStoreOptions) { this.options = options; }

  async refresh(options: { allowStaleOnError?: boolean; signal?: AbortSignal } = {}): Promise<CachedRegistry> {
    this.snapshot = await this.options.cache.refresh(this.options.source, options);
    return this.snapshot;
  }

  async registry(options: { refresh?: boolean; allowStale?: boolean } = {}): Promise<CachedRegistry> {
    if (options.refresh) return this.refresh({ allowStaleOnError: options.allowStale !== false });
    this.snapshot = this.snapshot ?? await this.options.cache.load({ allowStale: options.allowStale !== false });
    if (!this.snapshot) throw new PabRegistryError("REGISTRY_UNAVAILABLE", "No cached Ability Registry is available", {});
    return this.snapshot;
  }

  async list(query: StoreQuery = {}): Promise<AbilityRegistryEntry[]> {
    const document = (await this.registry()).document;
    return document.abilities.filter((entry) =>
      (!query.platform || entry.platforms.includes(query.platform)) &&
      (!query.category || entry.category === query.category) &&
      (!query.trust?.length || query.trust.includes(entry.trust))
    );
  }

  async find(query: string, options: StoreQuery = {}): Promise<AbilityRegistryEntry[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.list(options);
    return (await this.list(options)).filter((entry) => [entry.id, entry.name, entry.displayName, entry.description, entry.category].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }

  async getPack(packId: string): Promise<AbilityPackEntry> {
    const packs = (await this.registry()).document.packs ?? [];
    const pack = packs.find((candidate) => candidate.id === packId);
    if (!pack) throw new PabRegistryError("DEPENDENCY_MISSING", `Ability Pack not found: ${packId}`, { packId });
    return pack;
  }

  async install(id: string, options: InstallOptions & { range?: string; refresh?: boolean } ): Promise<{ entry: AbilityRegistryEntry; results: InstallResult[] }> {
    const snapshot = await this.registry({ refresh: options.refresh });
    const range = options.range ?? "*";
    const candidates = snapshot.document.abilities
      .filter((entry) => entry.id === id && entry.platforms.includes(options.platform) && satisfies(options.coreVersion, `>=${entry.minCoreVersion}`) && satisfies(entry.version, range))
      .sort((a, b) => compareVersions(b.version, a.version));
    const entry = candidates[0];
    if (!entry) throw new PabRegistryError("DEPENDENCY_MISSING", `No compatible registry entry for ${id}@${range}`, { id, range, platform: options.platform });
    const installed = Object.fromEntries((await this.options.moduleStore.listInstalled()).flatMap((state) => state.activeVersion ? [[state.id, state.activeVersion]] : []));
    const resolver = new DependencyResolver(snapshot.document, { platform: options.platform, coreVersion: options.coreVersion, installed });
    const coordinator = new AbilityInstallCoordinator(this.options.installer, resolver);
    const result = await coordinator.install({ [id]: entry.version }, options);
    return { entry, results: result.results };
  }

  async installPack(packId: string, options: InstallOptions & { refresh?: boolean }): Promise<{ pack: AbilityPackEntry; results: InstallResult[] }> {
    const snapshot = await this.registry({ refresh: options.refresh });
    const pack = (snapshot.document.packs ?? []).find((candidate) => candidate.id === packId);
    if (!pack) throw new PabRegistryError("DEPENDENCY_MISSING", `Ability Pack not found: ${packId}`, { packId });
    const installed = Object.fromEntries((await this.options.moduleStore.listInstalled()).flatMap((state) => state.activeVersion ? [[state.id, state.activeVersion]] : []));
    const resolver = new DependencyResolver(snapshot.document, { platform: options.platform, coreVersion: options.coreVersion, installed });
    const coordinator = new AbilityInstallCoordinator(this.options.installer, resolver);
    const result = await coordinator.install(Object.fromEntries(pack.abilities.map((id) => [id, "*"])), options);
    return { pack, results: result.results };
  }

  async update(id: string, options: UpdateOptions): Promise<UpdateResult> {
    const snapshot = await this.registry({ refresh: options.refresh });
    const state = await this.options.moduleStore.getState(id);
    const policy = state?.updatePolicy ?? { mode: "manual" as const, ignoredVersions: [] };
    const force = options.force === true;
    const trigger = options.trigger ?? "manual";
    const allCandidates = snapshot.document.abilities
      .filter((entry) => entry.id === id && entry.platforms.includes(options.platform) && satisfies(options.coreVersion, `>=${entry.minCoreVersion}`))
      .sort((a, b) => compareVersions(b.version, a.version));
    if (!allCandidates.length) throw new PabRegistryError("DEPENDENCY_MISSING", `No compatible registry entry for ${id}`, { id, platform: options.platform });
    if (!force && trigger === "automatic" && policy.mode !== "automatic") return { entry: allCandidates[0], results: [], updated: false, skipped: "manual-required" };

    let candidates = allCandidates;
    if (!force && policy.pinnedVersion) candidates = candidates.filter((entry) => entry.version === policy.pinnedVersion);
    else if (!force && options.range) candidates = candidates.filter((entry) => satisfies(entry.version, options.range!));
    if (!candidates.length) throw new PabRegistryError("DEPENDENCY_MISSING", `Pinned or requested version is unavailable for ${id}`, { id, pinnedVersion: policy.pinnedVersion, range: options.range });
    const ignored = new Set(policy.ignoredVersions ?? []);
    if (!force && !policy.pinnedVersion) {
      const available = candidates.filter((entry) => !ignored.has(entry.version));
      if (!available.length) return { entry: candidates[0], results: [], updated: false, skipped: "ignored" };
      if (state?.activeVersion) {
        const newestPublished = allCandidates[0];
        const newestAvailable = available[0];
        const publishedAhead = compareVersions(newestPublished.version, state.activeVersion) > 0;
        const availableAhead = compareVersions(newestAvailable.version, state.activeVersion) > 0;
        if (!availableAhead) return { entry: newestPublished, results: [], updated: false, skipped: publishedAhead ? "ignored" : "up-to-date" };
      }
      candidates = available;
    }
    const candidate = candidates[0];
    if (!force && state?.activeVersion === candidate.version) return { entry: candidate, results: [], updated: false, skipped: "up-to-date" };
    const result = await this.install(id, { ...options, force: undefined, trigger: undefined, refresh: false, range: `=${candidate.version}` });
    return { ...result, updated: true };
  }

  listInstalled() { return this.options.moduleStore.listInstalled(); }
  getUpdatePolicy(id: string) { return this.options.moduleStore.getUpdatePolicy(id); }
  setUpdatePolicy(id: string, policy: Partial<UpdatePolicy>) { return this.options.moduleStore.setUpdatePolicy(id, policy); }
  setUpdateMode(id: string, mode: UpdateMode) { return this.options.moduleStore.setUpdateMode(id, mode); }
  pinVersion(id: string, version: string | undefined) { return this.options.moduleStore.pinVersion(id, version); }
  ignoreVersion(id: string, version: string) { return this.options.moduleStore.ignoreVersion(id, version); }
  unignoreVersion(id: string, version: string) { return this.options.moduleStore.unignoreVersion(id, version); }
  enable(id: string) { return this.options.moduleStore.enable(id); }
  disable(id: string) { return this.options.moduleStore.disable(id); }
  rollback(id: string, version?: string) { return this.options.moduleStore.rollback(id, version); }
  uninstall(id: string, options: { removeData?: boolean } = {}) { return this.options.moduleStore.uninstall(id, options); }
}
