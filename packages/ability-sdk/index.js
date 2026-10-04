import { assertValidManifest, validateManifest, MANIFEST_SCHEMA_VERSION, PLATFORMS, PERMISSIONS } from "./manifest.js";

const noop = () => undefined;

/**
 * Declare an Ability in a form consumable by Core's loader.
 * The returned object is intentionally plain data plus lifecycle functions.
 */
export function defineAbility(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Ability definition must be an object.");
  if (typeof definition.activate !== "function") throw new TypeError("Ability definition must export activate(api).");
  // A callable default export works with the smallest possible Core loader
  // (`module.default(context)`) while retaining lifecycle properties for
  // richer loaders and the SDK's registerAbility helper.
  const callable = (api) => definition.activate(api);
  Object.assign(callable, {
    ...definition,
    activate: callable,
    deactivate: definition.deactivate ?? noop,
    onUpdate: definition.onUpdate ?? noop
  });
  return Object.freeze(callable);
}

/**
 * Create the constrained API exposed to an Ability. Runtime adapters may
 * implement only the methods supported on a given platform; unsupported
 * operations fail with a useful permission error.
 */
export function createAbilityContext(runtime, manifest, options = {}) {
  const normalized = assertValidManifest(manifest);
  const granted = new Set(options.grantedPermissions ?? normalized.permissions ?? []);
  const contributions = { pages: [], cards: [], commands: [], searchProviders: [], workflows: [], settings: [] };
  const subscriptions = new Set();
  // Core's native-neutral context and the SDK test adapter intentionally have
  // slightly different low-level names. Keep this shim here so an Ability
  // can be loaded by either host without importing Core internals.
  const coreLike = Boolean(runtime?.storage && runtime?.memory && typeof runtime?.registerPage === "function");
  const requirePermission = (permission) => {
    if (!permission) return;
    if (!granted.has(permission)) {
      const error = new Error(`Permission denied: ${permission}`);
      error.code = "PAB_PERMISSION_DENIED";
      error.permission = permission;
      throw error;
    }
  };
  const call = (name, ...args) => {
    const fn = runtime?.[name];
    if (typeof fn !== "function") throw new Error(`Runtime API is unavailable: ${name}`);
    return fn.call(runtime, ...args);
  };
  const addContribution = (kind, value) => {
    if (!value || typeof value !== "object") throw new TypeError(`${kind} contribution must be an object.`);
    const contribution = Object.freeze({ ...value, abilityId: normalized.id });
    contributions[kind].push(contribution);
    const registerName = `register${kind === "searchProviders" ? "SearchProvider" : kind === "workflows" ? "Workflow" : kind === "settings" ? "Setting" : kind.slice(0, -1).replace(/^./, (letter) => letter.toUpperCase())}`;
    const register = runtime?.[registerName];
    if (typeof register === "function") {
      const hostValue = kind === "commands" && value.execute && !value.handler ? { ...value, handler: value.execute } : value;
      const remove = register.call(runtime, hostValue);
      if (typeof remove === "function") subscriptions.add(remove);
    }
    return value.id ?? value.command ?? value.path;
  };
  const api = {
    manifest: normalized,
    sdkVersion: "0.1.0",
    runtimeVersion: runtime?.version ?? "unknown",
    registerPage: (value) => addContribution("pages", value),
    registerCard: (value) => addContribution("cards", value),
    registerCommand: (value) => addContribution("commands", value),
    registerRequest: (value) => {
      if (!value || typeof value !== "object") throw new TypeError("Request contribution must be an object.");
      const handler = value.handler ?? value.execute;
      if (typeof handler !== "function") throw new TypeError("Request contribution requires handler(payload, context).");
      const register = runtime?.registerRequest;
      if (typeof register !== "function") throw new Error("Runtime API is unavailable: registerRequest");
      const remove = register.call(runtime, { ...value, handler, abilityId: normalized.id });
      if (typeof remove === "function") subscriptions.add(remove);
      return value.id;
    },
    registerSearchProvider: (value) => addContribution("searchProviders", value),
    registerWorkflow: (value) => addContribution("workflows", value),
    registerSetting: (value) => addContribution("settings", value),
    getContributions: () => Object.fromEntries(Object.entries(contributions).map(([key, values]) => [key, [...values]])),
    subscribeEvent: (event, handler) => {
      if (typeof handler !== "function") throw new TypeError("Event handler must be a function.");
      const hostHandler = coreLike ? (envelope) => handler(envelope?.payload, envelope) : handler;
      const subscription = call("subscribeEvent", event, hostHandler);
      const unsubscribe = typeof subscription === "function" ? subscription : noop;
      subscriptions.add(unsubscribe);
      return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
    },
    publishEvent: (event, payload) => coreLike ? call("publishEvent", event, payload, { source: normalized.id }) : call("publishEvent", event, payload, normalized.id),
    request: (name, payload) => call("request", name, payload, normalized.id),
    openPage: (pageId, params) => coreLike ? runtime.openPage(pageId, params) : call("openPage", pageId, params, normalized.id),
    showNotification: (notification) => coreLike ? runtime.showNotification({ ...notification, abilityId: normalized.id }) : call("showNotification", { ...notification, abilityId: normalized.id }),
    storage: {
      get: (key, fallback) => {
        requirePermission("storage.private");
        return coreLike ? runtime.storage.get(key, fallback) : call("storageGet", normalized.id, key, fallback);
      },
      set: (key, value) => {
        requirePermission("storage.private");
        return coreLike ? runtime.storage.set(key, value) : call("storageSet", normalized.id, key, value);
      },
      delete: (key) => {
        requirePermission("storage.private");
        return coreLike ? runtime.storage.delete(key) : call("storageDelete", normalized.id, key);
      },
      keys: () => {
        requirePermission("storage.private");
        return coreLike ? runtime.storage.keys() : call("storageKeys", normalized.id);
      }
    },
    sharedStorage: {
      get: (key, fallback) => { requirePermission("storage.shared"); return call("sharedStorageGet", key, fallback); },
      set: (key, value) => { requirePermission("storage.shared"); return call("sharedStorageSet", key, value); }
    },
    memory: {
      query: (query) => { requirePermission("memory.read"); return coreLike ? runtime.memory.query(query) : call("memoryQuery", query, normalized.id); },
      write: (entry) => { requirePermission("memory.write"); return coreLike ? runtime.memory.write(entry) : call("memoryWrite", entry, normalized.id); }
    },
    requestPermission: async (permission, reason) => {
      if (!PERMISSIONS.includes(permission) && !String(permission).startsWith("custom.")) throw new Error(`Unknown permission: ${permission}`);
      const grantedNow = await (runtime?.requestPermission ? runtime.requestPermission(permission, reason, normalized.id) : false);
      const allowed = typeof grantedNow === "object" ? grantedNow[permission] === "allow" : Boolean(grantedNow);
      if (allowed) granted.add(permission);
      return allowed;
    },
    getSettings: () => coreLike ? runtime.settings?.get?.("value", {}) : call("getSettings", normalized.id),
    setSettings: (value) => coreLike ? runtime.settings?.set?.("value", value) : call("setSettings", normalized.id, value),
    log: (level, message, metadata) => (runtime?.log ? runtime.log(level, message, { ...metadata, abilityId: normalized.id }) : undefined),
    dispose: () => { for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); }
  };
  return Object.freeze(api);
}

/** Register an Ability and return an idempotent lifecycle handle. */
export async function registerAbility(runtime, manifest, definition, options = {}) {
  const normalized = assertValidManifest(manifest);
  const ability = typeof definition === "function" ? { activate: definition } : definition?.activate ? definition : definition?.default;
  if (!ability || typeof ability.activate !== "function") throw new TypeError("Ability entry must export activate(api).");
  const api = createAbilityContext(runtime, normalized, options);
  let active = false;
  let value;
  return {
    manifest: normalized,
    api,
    async activate() {
      if (!active) { value = await ability.activate(api); active = true; }
      return value;
    },
    async deactivate() {
      if (active) { await ability.deactivate?.(api); api.dispose(); active = false; }
    },
    async update(nextManifest, updateInfo) {
      const next = assertValidManifest(nextManifest);
      if (typeof ability.onUpdate === "function") await ability.onUpdate(api, updateInfo, next);
      return next;
    },
    get active() { return active; }
  };
}

export { assertValidManifest, validateManifest, createManifest, MANIFEST_SCHEMA_VERSION, PLATFORMS, PERMISSIONS } from "./manifest.js";
export { EVENTS } from "./events.js";
