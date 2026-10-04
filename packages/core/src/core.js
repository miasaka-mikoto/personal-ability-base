import { EventBus } from "./event-bus.js";
import { CommandBus } from "./command-bus.js";
import { RequestBus } from "./request-bus.js";
import { MemoryStorage, NamespacedStorage, StorageNamespace } from "./storage.js";
import { PermissionManager } from "./permissions.js";
import { ModuleStore } from "./module-store.js";
import { AbilityRuntime, ContributionRegistry } from "./ability-runtime.js";
import { ModuleManager } from "./module-manager.js";
import { MemoryRepository } from "./memory-repository.js";
import { SearchService } from "./search.js";
import { PabError, ErrorCode } from "./errors.js";
import { clone } from "./util.js";
import { LoadoutManager } from "./loadouts.js";
import { compareVersions } from "./semver.js";

export const CORE_VERSION = "0.1.0";

/**
 * Platform-neutral PAB Core. Native shells provide persistence, package
 * download/verification and UI callbacks; abilities see only the SDK context.
 */
export class PABCore {
  /** @param {{version?:string,platform?:string,storage?:any,promptPermission?:Function,loadAbility?:Function,downloadPackage?:Function,verifyHash?:Function,verifySignature?:Function,migrate?:Function,ui?:object,logger?:object,registry?:any,memory?:object,request?:Function,allowUnscopedRequests?:boolean}} [options] */
  constructor(options = {}) {
    this.version = options.version ?? CORE_VERSION;
    this.platform = options.platform ?? detectPlatform();
    this.storage = options.storage ?? new MemoryStorage();
    this.permissionStorage = new NamespacedStorage(this.storage, StorageNamespace.PERMISSIONS);
    this.settingsStorage = new NamespacedStorage(this.storage, StorageNamespace.SETTINGS);
    this.registryStorage = new NamespacedStorage(this.storage, StorageNamespace.REGISTRY);
    this.loadoutStorage = new NamespacedStorage(this.storage, "core/loadouts");
    // A tiny Core-owned tombstone store lets the Dashboard distinguish
    // "uninstalled, data kept" from "never installed" after module code is
    // removed. It contains no ability data or package bytes.
    this.moduleStateStorage = new NamespacedStorage(this.storage, StorageNamespace.MODULE_STATE);
    this.userDataStorage = new NamespacedStorage(this.storage, StorageNamespace.USERDATA);
    this.logger = options.logger ?? console;
    this.eventBus = new EventBus({ logger: this.logger });
    this.permissions = new PermissionManager({ storage: this.permissionStorage, eventBus: this.eventBus, prompt: options.promptPermission });
    this.commands = new CommandBus({ eventBus: this.eventBus, permissionManager: this.permissions });
    this.requests = new RequestBus({ eventBus: this.eventBus, permissionManager: this.permissions });
    this.contributions = new ContributionRegistry();
    this.memory = new MemoryRepository({ storage: this.userDataStorage });
    this.search = new SearchService({ memory: this.memory, contributions: this.contributions, eventBus: this.eventBus });
    this.loadouts = new LoadoutManager({ storage: this.loadoutStorage, eventBus: this.eventBus });
    this.moduleStore = new ModuleStore({ storage: new NamespacedStorage(this.storage, StorageNamespace.MODULES) });
    this.runtime = new AbilityRuntime({
      coreVersion: this.version,
      platform: this.platform,
      eventBus: this.eventBus,
      commandBus: this.commands,
      requestBus: this.requests,
      permissionManager: this.permissions,
      userDataStorage: this.userDataStorage,
      settingsStorage: this.settingsStorage,
      contributions: this.contributions,
      logger: this.logger,
      request: options.request,
      allowUnscopedRequests: options.allowUnscopedRequests === true,
      sharedStorage: new NamespacedStorage(this.storage, StorageNamespace.USERDATA),
      memory: {
        query: (query) => this.memory.query(query),
        querySync: (query) => this.memory.querySync(query),
        write: (entry) => this.memory.write(entry),
        writeSync: (entry) => this.memory.writeSync(entry),
      },
      ui: options.ui,
      loader: options.loadAbility,
    });
    this.modules = new ModuleManager({ coreVersion: this.version, platform: this.platform, store: this.moduleStore, runtime: this.runtime, eventBus: this.eventBus, registry: options.registry, download: options.downloadPackage, verifyHash: options.verifyHash, verifySignature: options.verifySignature, migrate: options.migrate });
    this.registry = options.registry;
    this.started = false;
    this.builtinCleanups = [];
  }

  async start() {
    if (this.started) return this;
    await this.moduleStore.load();
    await this.memory.load();
    await this.permissions.load();
    await this.loadouts.load();
    this.#registerBuiltins();
    this.started = true;
    // Rehydrate enabled modules after the shell restarts. A corrupt/missing
    // package must not prevent Core and the rest of the Base from opening.
    for (const record of await this.moduleStore.list()) {
      if (!record.enabled || !record.activeVersion) continue;
      if (typeof this.runtime.options.loader !== "function") continue;
      const version = record.versions[record.activeVersion];
      try {
        await this.runtime.activate({ manifest: version.manifest, packageRef: version.packageRef });
      } catch (error) {
        this.logger?.error?.("Unable to reactivate ability", { id: record.id, version: record.activeVersion, error });
        await this.eventBus.publish("ability.activation.failed", { id: record.id, version: record.activeVersion, error: String(error) }, { source: "core" });
      }
    }
    await this.eventBus.publish("core.started", { version: this.version, platform: this.platform }, { source: "core" });
    return this;
  }

  async stop() {
    if (!this.started) return;
    await this.runtime.deactivateAll();
    for (const cleanup of this.builtinCleanups.splice(0)) cleanup();
    this.started = false;
    await this.eventBus.publish("core.stopped", {}, { source: "core" });
  }

  async installAbility(packageOrId, options = {}) {
    const result = await this.modules.install(packageOrId, options);
    const id = result?.record?.id ?? result?.record?.manifest?.id;
    if (id) await this.moduleStateStorage.delete(id);
    return result;
  }
  async activateLoadout(id) { return this.loadouts.activate(id); }
  async request(name, payload, options = {}) { return this.requests.request(name, payload, options); }
  async refreshRegistry(source, options = {}) {
    if (!this.registry?.refresh) throw new PabError(ErrorCode.INVALID_STATE, "No registry service is configured");
    try {
      const cached = await this.registry.refresh(source, options);
      const document = cached?.document ?? cached;
      if (document?.abilities) this.modules.setCatalog(document.abilities);
      await this.registryStorage.set("cache", clone(cached));
      await this.eventBus.publish("registry.refreshed", { count: document?.abilities?.length ?? 0, stale: Boolean(cached?.meta?.stale) }, { source: "core" });
      return cached;
    } catch (error) {
      // A configured registry may expose its own stale-cache fallback. If it
      // does not, return the last Core cache so the Store remains usable offline.
      const fallback = await this.registryStorage.get("cache");
      if (fallback) {
        const document = fallback.document ?? fallback;
        if (document?.abilities) this.modules.setCatalog(document.abilities);
        await this.eventBus.publish("registry.offline", { count: document?.abilities?.length ?? 0, error: String(error) }, { source: "core" });
        return { ...fallback, meta: { ...(fallback.meta ?? {}), stale: true } };
      }
      throw error;
    }
  }
  async getRegistry({ allowStale = true } = {}) {
    if (this.registry?.load) {
      const loaded = await this.registry.load({ allowStale });
      if (loaded) {
        const document = loaded.document ?? loaded;
        if (document?.abilities) this.modules.setCatalog(document.abilities);
        return loaded;
      }
    }
    const cached = await this.registryStorage.get("cache");
    if (cached?.document?.abilities) this.modules.setCatalog(cached.document.abilities);
    return cached;
  }
  /**
   * Return the small, host-neutral snapshot consumed by the Dashboard bridge.
   * Registry metadata is optional; an offline Core can still render installed
   * modules and saved Loadouts.
   */
  async getDashboardSnapshot() {
    const records = await this.moduleStore.list();
    const retainedStates = new Map((await this.moduleStateStorage.entries()).map(([id, state]) => [id, state]));
    let registryEntries = [];
    try {
      const cached = await this.getRegistry({ allowStale: true });
      registryEntries = cached?.document?.abilities ?? cached?.abilities ?? [];
    } catch { /* Dashboard remains useful with module state only. */ }
    const byId = new Map();
    for (const entry of registryEntries) {
      const current = byId.get(entry.id);
      if (!current || compareVersions(entry.version, current.version) > 0) byId.set(entry.id, entry);
    }
    const recordById = new Map(records.map((record) => [record.id, record]));
    const ids = new Set([...byId.keys(), ...recordById.keys(), ...retainedStates.keys()]);
    // Resolve update policies once per installed module so an ignored or
    // pinned release does not keep showing an actionable update badge in the
    // Dashboard. The policy is Core metadata and remains independent from
    // module/user-data lifecycles.
    const policies = new Map(await Promise.all([...recordById.keys()].map(async (id) => [id, await this.modules.getUpdatePolicy(id)])));
    const abilities = [...ids].map((id) => {
      const record = recordById.get(id);
      const active = record?.activeVersion ? record.versions[record.activeVersion] : undefined;
      const manifest = active?.manifest ?? byId.get(id);
      const latest = byId.get(id);
      const installed = Boolean(record?.activeVersion);
      const policy = policies.get(id) ?? { mode: "manual" };
      const newer = Boolean(installed && latest && compareVersions(latest.version, record.activeVersion) > 0);
      const policyAllowsUpdate = policy.mode === "pinned"
        ? latest?.version === policy.version
        : policy.mode === "ignore"
          ? Boolean(policy.version) && latest?.version !== policy.version
          : true;
      const status = !installed ? "available" : !record.enabled ? "disabled" : newer && policyAllowsUpdate ? "update" : "installed";
      return {
        ...(latest ?? {}),
        ...(manifest ?? {}),
        id,
        version: active?.manifest?.version ?? latest?.version ?? "0.0.0",
        latestVersion: latest && latest.version !== (active?.manifest?.version ?? record?.activeVersion) && policyAllowsUpdate ? latest.version : undefined,
        status,
        permissions: [...new Set((manifest?.permissions ?? latest?.permissions ?? []))],
        dependencies: manifest?.dependencies ?? latest?.dependencies ?? {},
        contributes: contributionCounts(manifest?.contributes ?? latest?.contributes),
        dataRetained: !installed && Boolean(record?.dataRetained || retainedStates.get(id)?.dataRetained),
      };
    });
    return {
      schemaVersion: 1,
      abilities,
      loadouts: await this.loadouts.list(),
      activeLoadoutId: (await this.loadouts.active())?.id ?? null,
      activity: [],
    };
  }
  async updateAbility(packageOrId, options = {}) {
    const result = await this.modules.update(packageOrId, options);
    const id = result?.record?.id ?? result?.record?.manifest?.id;
    if (id) await this.moduleStateStorage.delete(id);
    return result;
  }
  async getAbilityUpdatePolicy(id) { return this.modules.getUpdatePolicy(id); }
  async setAbilityUpdatePolicy(id, policy) { return this.modules.setUpdatePolicy(id, policy); }
  async rollbackAbility(id, version, options = {}) { return this.modules.rollback(id, version, options); }
  async repairAbility(id, options = {}) {
    const record = await this.moduleStore.repair(id, options.version);
    if (options.activate !== false && record.enabled && record.activeVersion && typeof this.runtime.options.loader === "function") {
      await this.runtime.deactivate(id);
      const version = record.versions[record.activeVersion];
      await this.runtime.activate({ manifest: version.manifest, packageRef: version.packageRef }, { loader: options.loader });
    }
    await this.eventBus.publish("ability.repaired", { id, version: record.activeVersion }, { source: "core" });
    return record;
  }
  async resetAbility(id, { removeData = false, activate = true, loader } = {}) {
    const record = await this.moduleStore.get(id);
    if (!record) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id} is not installed`, { id });
    await this.runtime.deactivate(id);
    if (removeData) {
      await new NamespacedStorage(this.userDataStorage, `abilities/${id}`).clear();
      await new NamespacedStorage(this.settingsStorage, `abilities/${id}`).clear();
      await this.memory.deleteBySource(id);
    }
    if (activate && record.enabled && record.activeVersion && typeof this.runtime.options.loader === "function") {
      const version = record.versions[record.activeVersion];
      await this.runtime.activate({ manifest: version.manifest, packageRef: version.packageRef }, { loader });
    }
    await this.eventBus.publish("ability.reset", { id, dataRemoved: removeData }, { source: "core" });
    return { id, dataRemoved: removeData, dataPreserved: !removeData };
  }
  async enableAbility(id, options = {}) { return this.modules.enable(id, options); }
  async disableAbility(id) { return this.modules.disable(id); }
  async uninstallAbility(id, options = {}) {
    // `keepData` is the UI-friendly alias; the Core contract also accepts
    // the explicit `removeData` flag.  Removing module code never implicitly
    // removes the separately namespaced user data.
    const normalizedOptions = typeof options === "boolean" ? { keepData: options } : options;
    const removeData = normalizedOptions.removeData === true || normalizedOptions.keepData === false;
    const result = await this.modules.uninstall(id, normalizedOptions);
    const dataPreserved = !removeData;
    if (normalizedOptions.removeModule !== false) {
      if (dataPreserved) await this.moduleStateStorage.set(id, { dataRetained: true, uninstalledAt: Date.now() });
      else await this.moduleStateStorage.delete(id);
    }
    if (removeData) {
      await new NamespacedStorage(this.userDataStorage, `abilities/${id}`).clear();
      await new NamespacedStorage(this.settingsStorage, `abilities/${id}`).clear();
      await this.memory.deleteBySource(id);
      await this.permissions.revoke(id);
    }
    // A removed module should not remain in a saved focus preset, while a
    // disabled module remains available to re-enable in its loadout.
    if (normalizedOptions.removeModule !== false) {
      for (const loadout of await this.loadouts.list()) {
        if (loadout.abilityIds.includes(id)) {
          await this.loadouts.update(loadout.id, { abilityIds: loadout.abilityIds.filter((item) => item !== id) });
        }
      }
    }
    return { ...result, dataPreserved, dataRemoved: removeData };
  }

  async exportAbilityData(id) {
    const dataStorage = new NamespacedStorage(this.userDataStorage, `abilities/${id}`);
    const settings = new NamespacedStorage(this.settingsStorage, `abilities/${id}`);
    return {
      schemaVersion: 1,
      abilityId: id,
      exportedAt: Date.now(),
      storage: Object.fromEntries(await dataStorage.entries()),
      settings: Object.fromEntries(await settings.entries()),
      memories: await this.memory.query({ source: id, limit: Number.MAX_SAFE_INTEGER }),
    };
  }

  async importAbilityData(id, snapshot, { replace = false } = {}) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.abilityId !== id) throw new PabError(ErrorCode.INVALID_STATE, "Ability data snapshot does not match the target Ability", { id });
    const dataStorage = new NamespacedStorage(this.userDataStorage, `abilities/${id}`);
    const settings = new NamespacedStorage(this.settingsStorage, `abilities/${id}`);
    if (replace) {
      await dataStorage.clear();
      await settings.clear();
      await this.memory.deleteBySource(id);
    }
    for (const [key, value] of Object.entries(snapshot.storage ?? {})) await dataStorage.set(key, clone(value));
    for (const [key, value] of Object.entries(snapshot.settings ?? {})) await settings.set(key, clone(value));
    for (const memory of snapshot.memories ?? []) await this.memory.write({ ...memory, source: id, id: replace ? undefined : memory.id });
    await this.eventBus.publish("ability.data.imported", { id, replace }, { source: "core" });
    return this.exportAbilityData(id);
  }

  async backup({ includeRegistry = true } = {}) {
    const modules = await this.moduleStore.list();
    const updatePolicies = Object.fromEntries(await Promise.all(modules.map(async (module) => [module.id, await this.moduleStore.getUpdatePolicy(module.id)])));
    return {
      schemaVersion: 1,
      createdAt: Date.now(),
      coreVersion: this.version,
      userData: { memories: await this.memory.all() },
      settings: Object.fromEntries(await this.settingsStorage.entries()),
      permissions: await this.permissionStorage.get("grants", {}),
      modules,
      updatePolicies,
      moduleState: Object.fromEntries(await this.moduleStateStorage.entries()),
      loadouts: await this.loadouts.list(),
      activeLoadoutId: (await this.loadouts.active())?.id ?? null,
      registry: includeRegistry ? clone(await this.registryStorage.get("cache", null)) : undefined,
    };
  }

  async restore(snapshot, { restoreModules = false, restoreSettings = true } = {}) {
    if (!snapshot || snapshot.schemaVersion !== 1) throw new PabError(ErrorCode.INVALID_STATE, "Unsupported PAB backup schema");
    if (restoreSettings && snapshot.settings) {
      for (const [key, value] of Object.entries(snapshot.settings)) await this.settingsStorage.set(key, clone(value));
    }
    if (snapshot.userData?.memories) {
      for (const memory of snapshot.userData.memories) await this.memory.write(memory);
    }
    if (snapshot.permissions) {
      await this.permissionStorage.set("grants", clone(snapshot.permissions));
      this.permissions.loaded = false;
      await this.permissions.load();
    }
    if (snapshot.registry) await this.registryStorage.set("cache", clone(snapshot.registry));
    if (snapshot.moduleState) {
      await this.moduleStateStorage.clear();
      for (const [id, state] of Object.entries(snapshot.moduleState)) await this.moduleStateStorage.set(id, clone(state));
    }
    if (snapshot.updatePolicies && typeof snapshot.updatePolicies === "object") {
      for (const [id, policy] of Object.entries(snapshot.updatePolicies)) await this.moduleStore.setUpdatePolicy(id, policy);
    }
    if (Array.isArray(snapshot.loadouts)) {
      for (const loadout of snapshot.loadouts) {
        if (await this.loadouts.get(loadout.id)) await this.loadouts.update(loadout.id, loadout);
        else await this.loadouts.create(loadout);
      }
      if (snapshot.activeLoadoutId && await this.loadouts.get(snapshot.activeLoadoutId)) await this.loadouts.activate(snapshot.activeLoadoutId);
    }
    if (restoreModules && Array.isArray(snapshot.modules)) {
      for (const record of snapshot.modules) {
        for (const version of Object.values(record.versions ?? {})) await this.moduleStore.installVersion(version.manifest, { ...version, activate: false });
        if (record.activeVersion && await this.moduleStore.has(record.id)) {
          await this.moduleStore.activate(record.id, record.activeVersion);
          if (!record.enabled) await this.moduleStore.disable(record.id);
        }
      }
    }
    await this.eventBus.publish("core.restored", { restoreModules, restoreSettings }, { source: "core" });
  }

  async diagnostics() {
    const modules = await this.moduleStore.list();
    return { coreVersion: this.version, platform: this.platform, started: this.started, modules, activeAbilities: modules.filter((module) => module.enabled).map((module) => module.id), eventSubscriptions: this.eventBus.size, commands: this.commands.list(), requests: this.requests.list() };
  }

  #registerBuiltins() {
    if (this.builtinCleanups.length) return;
    this.builtinCleanups.push(this.commands.register({ id: "core.search", title: "Search", handler: (query, options) => this.search.search(query, options) }));
    this.builtinCleanups.push(this.commands.register({ id: "core.capture", title: "Capture", handler: (entry) => this.memory.write({ ...entry, source: entry?.source ?? "core.capture" }) }));
    this.builtinCleanups.push(this.commands.register({ id: "core.recall", title: "Recall", handler: (query) => this.memory.query(query) }));
  }
}

function contributionCounts(contributes = {}) {
  const count = (value) => Array.isArray(value) ? value.length : Number.isFinite(value) ? value : 0;
  return {
    pages: count(contributes.pages),
    commands: count(contributes.commands),
    cards: count(contributes.cards),
    workflows: count(contributes.workflows),
  };
}

function detectPlatform() {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("android")) return "android";
    if (ua.includes("windows")) return "windows";
  }
  if (typeof process !== "undefined" && process.platform === "win32") return "windows";
  return "web";
}
