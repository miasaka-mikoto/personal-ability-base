import { ErrorCode, PabError } from "./errors.js";
import { NamespacedStorage } from "./storage.js";

/** Registry of UI and discovery contributions owned by abilities. */
export class ContributionRegistry {
  constructor() { this.byAbility = new Map(); }
  add(abilityId, type, contribution) {
    if (!this.byAbility.has(abilityId)) this.byAbility.set(abilityId, new Map());
    const contributions = this.byAbility.get(abilityId);
    if (!contributions.has(type)) contributions.set(type, []);
    const item = { ...contribution, abilityId };
    contributions.get(type).push(item);
    return () => {
      const values = contributions.get(type) ?? [];
      const index = values.indexOf(item);
      if (index >= 0) values.splice(index, 1);
    };
  }
  list(type, { abilityId } = {}) {
    const records = [];
    for (const [owner, groups] of this.byAbility) if (!abilityId || owner === abilityId) records.push(...(groups.get(type) ?? []));
    return records.map((item) => ({ ...item }));
  }
  removeAbility(abilityId) { this.byAbility.delete(abilityId); }
  clear() { this.byAbility.clear(); }
}

/**
 * Controlled JS ability runtime. Native shells provide a loader that resolves
 * a package entry (or a Web Worker/WASM adapter); abilities only receive the
 * narrow context below and cannot access Core internals directly.
 */
export class AbilityRuntime {
  /** @param {{coreVersion?:string,platform?:string,eventBus:any,commandBus:any,requestBus?:any,permissionManager:any,userDataStorage?:any,settingsStorage?:any,contributions?:ContributionRegistry,memory?:{query?:Function,write?:Function},ui?:{openPage?:Function,showNotification?:Function},loader?:(request:object)=>Promise<object>|object}} options */
  constructor(options) {
    if (!options?.eventBus || !options?.commandBus || !options?.permissionManager) throw new TypeError("AbilityRuntime requires eventBus, commandBus and permissionManager");
    this.options = options;
    this.contributions = options.contributions ?? new ContributionRegistry();
    this.active = new Map();
  }

  async activate(record, options = {}) {
    const manifest = record.manifest ?? record.versions?.[record.activeVersion]?.manifest;
    if (!manifest) throw new PabError(ErrorCode.INVALID_MANIFEST, "Cannot activate a record without a manifest");
    const abilityId = manifest.id;
    if (this.active.has(abilityId)) return this.active.get(abilityId).handle;
    const decisions = await this.options.permissionManager.request(abilityId, manifest.permissions, { manifest, action: "activate" });
    const denied = Object.entries(decisions).filter(([, decision]) => decision !== "allow");
    if (denied.length) throw new PabError(ErrorCode.PERMISSION_DENIED, `${abilityId} permissions were not granted`, { denied: Object.fromEntries(denied) });
    const cleanups = [];
    const storage = new NamespacedStorage(this.options.userDataStorage, `abilities/${abilityId}`);
    const settings = new NamespacedStorage(this.options.settingsStorage ?? this.options.userDataStorage, `abilities/${abilityId}`);
    const sharedStorage = new NamespacedStorage(this.options.sharedStorage ?? this.options.userDataStorage, "shared");
    const context = this.#createContext(manifest, storage, settings, sharedStorage, cleanups);
    const loader = options.loader ?? this.options.loader;
    if (typeof loader !== "function") throw new PabError(ErrorCode.INVALID_STATE, `No loader configured for ${abilityId}`);
    const module = await loader({ manifest, record, entry: manifest.entry, packageRef: record.packageRef });
    const exported = module?.activate ?? module?.default ?? module;
    const activate = typeof exported === "function" ? exported : exported?.activate;
    if (typeof activate !== "function") throw new PabError(ErrorCode.INVALID_STATE, `${abilityId} entry does not export activate(context)`);
    let instance;
    try { instance = await activate(context); } catch (error) {
      for (const cleanup of cleanups.reverse()) await safeCall(cleanup);
      throw error;
    }
    const handle = { abilityId, manifest, instance, context, deactivate: async () => this.deactivate(abilityId) };
    this.active.set(abilityId, { handle, module, cleanups });
    await this.options.eventBus.publish("ability.activated", { abilityId, version: manifest.version }, { source: abilityId });
    return handle;
  }

  async deactivate(abilityId) {
    const active = this.active.get(abilityId);
    if (!active) return false;
    try {
      const exported = active.module?.default ?? active.module;
      const deactivate = active.module?.deactivate ?? exported?.deactivate;
      await deactivate?.(active.handle?.context);
    } finally {
      for (const cleanup of active.cleanups.reverse()) await safeCall(cleanup);
      this.contributions.removeAbility(abilityId);
      this.active.delete(abilityId);
      await this.options.eventBus.publish("ability.deactivated", { abilityId }, { source: "core" });
    }
    return true;
  }

  async deactivateAll({ throwOnError = false } = {}) {
    const errors = [];
    for (const id of [...this.active.keys()]) {
      try { await this.deactivate(id); }
      catch (error) {
        errors.push({ id, error });
        if (throwOnError) throw error;
        this.options.eventBus.publish("ability.deactivation.failed", { id, error: String(error) }, { source: "core" });
      }
    }
    return errors;
  }
  isActive(id) { return this.active.has(id); }
  getContext(id) { return this.active.get(id)?.handle.context; }

  #createContext(manifest, storage, settings, sharedStorage, cleanups) {
    const abilityId = manifest.id;
    const add = (type, contribution) => {
      const remove = this.contributions.add(abilityId, type, contribution);
      cleanups.push(remove);
      return remove;
    };
    const subscribeEvent = (pattern, handler, options) => {
      const remove = this.options.eventBus.subscribe(pattern, (event) => handler(event.payload, event), options);
      cleanups.push(remove);
      return remove;
    };
    const require = (permission) => this.options.permissionManager.assert(abilityId, permission);
    return Object.freeze({
      abilityId,
      manifest,
      sdkVersion: "0.1.0",
      runtimeVersion: this.options.coreVersion ?? "0.1.0",
      registerPage: (definition) => add("pages", definition),
      registerCard: (definition) => add("cards", definition),
      registerCommand: (definition) => {
        const handler = definition.handler ?? definition.execute;
        const unregister = this.options.commandBus.register({ ...definition, abilityId, handler });
        cleanups.push(unregister);
        add("commands", { ...definition, handler: undefined, execute: undefined });
        return unregister;
      },
      registerRequest: (definition) => {
        const unregister = this.options.requestBus?.register({ ...definition, abilityId });
        if (typeof unregister !== "function") throw new PabError(ErrorCode.INVALID_STATE, "Request bus is unavailable");
        cleanups.push(unregister);
        return unregister;
      },
      registerSearchProvider: (definition) => add("searchProviders", definition),
      registerWorkflow: (definition) => add("workflows", definition),
      registerSetting: (definition) => add("settings", definition),
      registerSettings: (definition) => add("settings", definition),
      getContributions: () => Object.fromEntries(["pages", "commands", "cards", "searchProviders", "workflows", "settings"].map((type) => [type, this.contributions.list(type, { abilityId })])),
      subscribeEvent,
      publishEvent: (type, payload, options = {}) => this.options.eventBus.publish(type, payload, { ...options, source: abilityId }),
      openPage: (pageId, params) => this.options.ui?.openPage?.(pageId, params),
      showNotification: (notification) => this.options.ui?.showNotification?.({ ...notification, abilityId }),
      request: async (name, payload) => {
        const requestName = String(name ?? "");
        const prefix = requestName.split(/[.:/]/, 1)[0];
        const permissionByPrefix = {
          network: "network",
          camera: "camera",
          microphone: "microphone",
          location: "location",
          clipboard: "clipboard",
          filesystem: requestName.includes("export") ? "filesystem.export" : "filesystem.import",
          export: "filesystem.export",
        };
        const required = permissionByPrefix[prefix];
        if (required) await require(required);
        if (this.options.requestBus?.has?.(requestName)) {
          return this.options.requestBus.request(requestName, payload, { source: abilityId });
        }
        if (!this.options.request) throw new PabError(ErrorCode.INVALID_STATE, `No request handler is configured for ${requestName}`);
        if (!required && this.options.allowUnscopedRequests !== true) {
          throw new PabError(ErrorCode.PERMISSION_DENIED, `Unscoped Ability request is disabled: ${requestName}`, { abilityId, requestName });
        }
        return this.options.request(requestName, payload, abilityId);
      },
      log: (level, message, metadata = {}) => {
        const logger = this.options.logger ?? console;
        const method = typeof logger[level] === "function" ? logger[level] : logger.log;
        method?.call(logger, `[${abilityId}] ${message}`, metadata);
      },
      storage: {
        get: (key, fallback) => gate(require("storage.private"), () => storage.get(key, fallback)),
        set: (key, value) => gate(require("storage.private"), () => storage.set(key, value)),
        delete: (key) => gate(require("storage.private"), () => storage.delete(key)),
        keys: () => gate(require("storage.private"), () => storage.keys()),
        clear: () => gate(require("storage.private"), () => storage.clear()),
      },
      settings: {
        get: (key, fallback) => settings.get(key, fallback),
        set: (key, value) => settings.set(key, value),
        delete: (key) => settings.delete(key),
      },
      sharedStorage: {
        get: async (key, fallback) => { await require("storage.shared"); return sharedStorage.get(key, fallback); },
        set: async (key, value) => { await require("storage.shared"); return sharedStorage.set(key, value); },
      },
      getSettings: (key, fallback) => settings.get(key, fallback),
      setSettings: (key, value) => settings.set(key, value),
      memory: {
        query: (query) => {
          const permission = require("memory.read");
          const read = () => this.options.memory?.querySync?.(query) ?? this.options.memory?.query?.(query) ?? [];
          return permission?.then ? permission.then(read) : read();
        },
        write: (entry) => {
          const permission = require("memory.write");
          // Stamp writes with their owning Ability unless the module
          // deliberately supplies a more specific source. This keeps
          // per-Ability export/reset and data-retention operations reliable
          // without exposing the Core repository to module code.
          const ownedEntry = {
            ...(entry ?? {}),
            source: entry?.source ?? abilityId,
            metadata: { ...(entry?.metadata ?? {}), abilityId: entry?.metadata?.abilityId ?? abilityId },
          };
          const write = () => this.options.memory?.writeSync?.(ownedEntry) ?? this.options.memory?.write?.(ownedEntry);
          return permission?.then ? permission.then(write) : write();
        },
      },
      requestPermission: (permission) => this.options.permissionManager.request(abilityId, [permission], { manifest, action: "runtime" }),
      dispose: () => this.deactivate(abilityId),
    });
  }
}

async function safeCall(fn) {
  try { await fn?.(); } catch { /* cleanup must not mask the original error */ }
}

function gate(permissionPromise, action) {
  return Promise.resolve(permissionPromise).then(() => action());
}
