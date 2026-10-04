/**
 * PAB host capability adapters.
 *
 * This package deliberately has no WebView2, Tauri, Android, or Capacitor
 * dependency. Native shells inject a small transport object and keep all
 * platform-specific code outside Ability packages. The same adapter API is
 * therefore usable in a browser preview, a Windows shell, and an Android
 * shell.
 */

const HOST_METHOD = Object.freeze({
  START: "host.start",
  STOP: "host.stop",
  HOTKEY_REGISTER: "globalHotkey.register",
  HOTKEY_UNREGISTER: "globalHotkey.unregister",
  QUICK_TILE_REGISTER: "quickTile.register",
  QUICK_TILE_UNREGISTER: "quickTile.unregister",
  SHARE_TARGET_REGISTER: "shareTarget.register",
  SHARE_TARGET_UNREGISTER: "shareTarget.unregister",
  NOTIFY: "notifications.show",
  NOTIFY_DISMISS: "notifications.dismiss",
  STORAGE_GET: "storage.get",
  STORAGE_SET: "storage.set",
  STORAGE_DELETE: "storage.delete",
  STORAGE_KEYS: "storage.keys",
  STORAGE_CLEAR: "storage.clear",
});

export const HostMethod = HOST_METHOD;

export const HostEvent = Object.freeze({
  STARTED: "host.started",
  STOPPED: "host.stopped",
  HOTKEY: "host.hotkey",
  QUICK_TILE: "host.quickTile",
  SHARE: "host.share",
  NOTIFICATION_ACTION: "host.notificationAction",
  RESPONSE: "host.response",
  ERROR: "host.error",
});

export const HostCapability = Object.freeze({
  GLOBAL_HOTKEY: "globalHotkey",
  QUICK_TILE: "quickTile",
  SHARE_TARGET: "shareTarget",
  NOTIFICATIONS: "notifications",
  PERSISTENT_STORAGE: "persistentStorage",
});

const DEFAULT_CAPABILITIES = Object.freeze({
  globalHotkey: false,
  quickTile: false,
  shareTarget: false,
  notifications: true,
  persistentStorage: true,
});

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  if (value === null || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function id(prefix = "pab") {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asPromise(value) { return value && typeof value.then === "function" ? value : Promise.resolve(value); }

function normalizeDefinition(definition, kind) {
  if (!definition || typeof definition !== "object") throw new TypeError(`${kind} definition is required`);
  const definitionId = String(definition.id ?? "").trim();
  if (!definitionId) throw new TypeError(`${kind} id is required`);
  const commandId = definition.commandId === undefined ? undefined : String(definition.commandId).trim();
  if (!commandId && typeof definition.handler !== "function") {
    throw new TypeError(`${kind} requires commandId or handler`);
  }
  // `structuredClone` and the JSON fallback intentionally reject/drop
  // functions. Keep a local handler explicitly so shell-side tests and
  // lightweight preview integrations can route without a Core Command Bus.
  const cloned = clone(definition) ?? {};
  if (typeof definition.handler === "function") cloned.handler = definition.handler;
  return {
    ...cloned,
    id: definitionId,
    commandId: commandId || undefined,
    title: definition.title ?? definitionId,
  };
}

/** Error type emitted when a host capability is missing or unavailable. */
export class HostAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HostAdapterError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Minimal async key/value store. It is intentionally serialisable and is used
 * by previews/tests when a native SQLite/DataStore implementation is absent.
 */
export class MemoryHostStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(clone(initial) ?? {}));
  }

  async get(key, fallback = undefined) {
    const value = this.values.has(String(key)) ? this.values.get(String(key)) : fallback;
    return clone(value);
  }

  async set(key, value) {
    this.values.set(String(key), clone(value));
    return clone(value);
  }

  async delete(key) { return this.values.delete(String(key)); }
  async has(key) { return this.values.has(String(key)); }
  async keys(prefix = "") { return [...this.values.keys()].filter((key) => key.startsWith(String(prefix))); }
  async entries(prefix = "") {
    return (await this.keys(prefix)).map((key) => [key, clone(this.values.get(key))]);
  }
  async clear(prefix = "") {
    for (const key of await this.keys(prefix)) this.values.delete(key);
  }
}

/** Add an isolated namespace to any async host storage implementation. */
export class NamespacedHostStorage {
  constructor(storage, namespace) {
    if (!storage) throw new TypeError("storage is required");
    this.storage = storage;
    this.namespace = String(namespace ?? "").replace(/^\/+|\/+$/g, "");
  }
  key(key) { return this.namespace ? `${this.namespace}/${String(key).replace(/^\/+/, "")}` : String(key); }
  get(key, fallback) { return this.storage.get(this.key(key), fallback); }
  set(key, value) { return this.storage.set(this.key(key), value); }
  delete(key) { return this.storage.delete(this.key(key)); }
  has(key) { return this.storage.has(this.key(key)); }
  keys() {
    const prefix = this.namespace ? `${this.namespace}/` : "";
    return asPromise(this.storage.keys(prefix)).then((keys) => keys.map((key) => key.slice(prefix.length)));
  }
  entries() {
    const prefix = this.namespace ? `${this.namespace}/` : "";
    return asPromise(this.storage.entries(prefix)).then((entries) => entries.map(([key, value]) => [key.slice(prefix.length), value]));
  }
  clear() {
    const prefix = this.namespace ? `${this.namespace}/` : "";
    return this.storage.clear(prefix);
  }
}

/**
 * Storage adapter which asks the native transport first and falls back to a
 * local store when the shell is not connected. The fallback makes first-run
 * and offline preview deterministic; a native shell should provide all five
 * storage methods for durable user data.
 */
export class BridgeHostStorage {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.fallback = options.fallback ?? new MemoryHostStorage();
    this.namespace = options.namespace ?? "pab";
  }

  async call(method, payload, fallback) {
    if (typeof this.transport?.invoke !== "function") return fallback();
    try {
      const result = await this.transport.invoke(method, { namespace: this.namespace, ...payload });
      // A one-way transport returns an acknowledgement object. Treat it as a
      // missing value so reads remain backed by the local fallback.
      if (result && result.dispatched === true && Object.keys(result).every((key) => ["dispatched", "requestId"].includes(key))) return fallback();
      return result === undefined ? fallback() : result;
    } catch {
      return fallback();
    }
  }
  get(key, fallbackValue) { return this.call(HOST_METHOD.STORAGE_GET, { key: String(key) }, () => this.fallback.get(key, fallbackValue)); }
  set(key, value) { return this.call(HOST_METHOD.STORAGE_SET, { key: String(key), value: clone(value) }, () => this.fallback.set(key, value)); }
  delete(key) { return this.call(HOST_METHOD.STORAGE_DELETE, { key: String(key) }, () => this.fallback.delete(key)); }
  has(key) { return this.get(key, undefined).then((value) => value !== undefined); }
  keys(prefix = "") { return this.call(HOST_METHOD.STORAGE_KEYS, { prefix: String(prefix) }, () => this.fallback.keys(prefix)); }
  entries(prefix = "") { return this.call("storage.entries", { prefix: String(prefix) }, () => this.fallback.entries(prefix)); }
  clear(prefix = "") { return this.call(HOST_METHOD.STORAGE_CLEAR, { prefix: String(prefix) }, () => this.fallback.clear(prefix)); }
}

/**
 * A browser localStorage implementation for WebView previews. Values are
 * JSON encoded and all methods remain async to match native storage.
 */
export class WebStorageAdapter {
  constructor(storage = globalThis.localStorage, options = {}) {
    this.storage = storage;
    this.prefix = options.prefix ?? "pab";
    this.fallback = options.fallback ?? new MemoryHostStorage();
  }
  key(key) { return `${this.prefix}/${String(key)}`; }
  async get(key, fallback) {
    if (!this.storage) return this.fallback.get(key, fallback);
    try { const raw = this.storage.getItem(this.key(key)); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; }
  }
  async set(key, value) {
    if (!this.storage) return this.fallback.set(key, value);
    try { this.storage.setItem(this.key(key), JSON.stringify(value)); return clone(value); } catch { return this.fallback.set(key, value); }
  }
  async delete(key) {
    if (!this.storage) return this.fallback.delete(key);
    try { const existed = this.storage.getItem(this.key(key)) !== null; this.storage.removeItem(this.key(key)); return existed; } catch { return this.fallback.delete(key); }
  }
  async has(key) { return (await this.get(key, undefined)) !== undefined; }
  async keys(prefix = "") {
    const result = [];
    if (!this.storage) return this.fallback.keys(prefix);
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      const marker = `${this.prefix}/`;
      if (key?.startsWith(marker)) {
        const unprefixed = key.slice(marker.length);
        if (unprefixed.startsWith(prefix)) result.push(unprefixed);
      }
    }
    return result;
  }
  async entries(prefix = "") { return Promise.all((await this.keys(prefix)).map(async (key) => [key, await this.get(key)])); }
  async clear(prefix = "") { for (const key of await this.keys(prefix)) await this.delete(key); }
}

/**
 * Base adapter shared by all shells. It owns registration and routing only;
 * native transports are responsible for OS-level UI and persistence.
 */
export class HostAdapter {
  constructor(options = {}) {
    this.platform = options.platform ?? "unknown";
    this.kind = options.kind ?? "generic";
    this.bridge = options.bridge ?? options.transport;
    this.core = options.core;
    this.logger = options.logger ?? console;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(options.capabilities ?? {}) };
    this.storage = options.storage ?? new BridgeHostStorage(this.bridge, { fallback: options.fallbackStorage ?? new MemoryHostStorage(), namespace: options.storageNamespace ?? "pab" });
    this.commandExecutor = options.commandExecutor;
    this.started = false;
    this.hotkeys = new Map();
    this.quickTiles = new Map();
    this.shareTargets = new Map();
    this.notifications = new Map();
    this.listeners = new Map();
    this.unsubscribeTransport = undefined;
  }

  supports(capability) { return this.capabilities[capability] === true; }
  getCapabilities() { return { ...this.capabilities }; }

  on(event, handler) {
    if (typeof handler !== "function") throw new TypeError("Host event handler must be a function");
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler); this.listeners.set(event, set);
    return () => set.delete(handler);
  }

  async emit(event, payload) {
    const envelope = { id: id("host_evt"), event, platform: this.platform, kind: this.kind, timestamp: Date.now(), payload: clone(payload) };
    for (const handler of this.listeners.get(event) ?? []) {
      try { await handler(envelope); } catch (error) { this.logger?.error?.("PAB host event handler failed", { event, error }); }
    }
    for (const handler of this.listeners.get("*") ?? []) {
      try { await handler(envelope); } catch (error) { this.logger?.error?.("PAB host wildcard handler failed", { event, error }); }
    }
    return envelope;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    if (typeof this.bridge?.onMessage === "function") {
      this.unsubscribeTransport = this.bridge.onMessage((message) => {
        // Native event emitters do not await a returned Promise. Consume
        // routing failures here so a malformed host event cannot become an
        // unhandled rejection in the WebView/Capacitor process.
        Promise.resolve(this.handleHostMessage(message)).catch((error) => this.logger?.error?.("PAB host message failed", { error }));
      });
    }
    await this.invoke(HOST_METHOD.START, { platform: this.platform, kind: this.kind, capabilities: this.getCapabilities() });
    await this.emit(HostEvent.STARTED, { capabilities: this.getCapabilities() });
    return this;
  }

  async stop() {
    if (!this.started) return;
    if (typeof this.unsubscribeTransport === "function") this.unsubscribeTransport();
    this.unsubscribeTransport = undefined;
    await this.invoke(HOST_METHOD.STOP, { platform: this.platform, kind: this.kind });
    this.started = false;
    await this.emit(HostEvent.STOPPED, {});
  }

  async invoke(method, payload) {
    if (typeof this.bridge?.invoke === "function") return this.bridge.invoke(method, clone(payload));
    if (typeof this.bridge?.call === "function") return this.bridge.call(method, clone(payload));
    if (typeof this.bridge?.[method] === "function") return this.bridge[method](clone(payload));
    return undefined;
  }

  _require(capability, operation) {
    if (!this.supports(capability)) throw new HostAdapterError("CAPABILITY_UNAVAILABLE", `${operation} is not available on ${this.platform}`, { platform: this.platform, capability });
  }

  async registerGlobalHotkey(definition) {
    this._require(HostCapability.GLOBAL_HOTKEY, "Global hotkey");
    const normalized = normalizeDefinition(definition, "Global hotkey");
    if (this.hotkeys.has(normalized.id)) throw new HostAdapterError("ALREADY_REGISTERED", `Global hotkey already registered: ${normalized.id}`, { id: normalized.id });
    this.hotkeys.set(normalized.id, normalized);
    await this.invoke(HOST_METHOD.HOTKEY_REGISTER, publicDefinition(normalized));
    return this._disposer(this.hotkeys, normalized.id, HOST_METHOD.HOTKEY_UNREGISTER, normalized);
  }

  async registerQuickTile(definition) {
    this._require(HostCapability.QUICK_TILE, "Quick Tile");
    const normalized = normalizeDefinition(definition, "Quick Tile");
    if (this.quickTiles.has(normalized.id)) throw new HostAdapterError("ALREADY_REGISTERED", `Quick Tile already registered: ${normalized.id}`, { id: normalized.id });
    this.quickTiles.set(normalized.id, normalized);
    await this.invoke(HOST_METHOD.QUICK_TILE_REGISTER, publicDefinition(normalized));
    return this._disposer(this.quickTiles, normalized.id, HOST_METHOD.QUICK_TILE_UNREGISTER, normalized);
  }

  async registerShareTarget(definition) {
    this._require(HostCapability.SHARE_TARGET, "Share Target");
    const normalized = normalizeDefinition(definition, "Share target");
    if (this.shareTargets.has(normalized.id)) throw new HostAdapterError("ALREADY_REGISTERED", `Share target already registered: ${normalized.id}`, { id: normalized.id });
    this.shareTargets.set(normalized.id, normalized);
    await this.invoke(HOST_METHOD.SHARE_TARGET_REGISTER, publicDefinition(normalized));
    return this._disposer(this.shareTargets, normalized.id, HOST_METHOD.SHARE_TARGET_UNREGISTER, normalized);
  }

  _disposer(map, key, nativeMethod, definition) {
    let disposed = false;
    return async () => {
      if (disposed) return false;
      disposed = true;
      map.delete(key);
      await this.invoke(nativeMethod, { id: definition.id });
      return true;
    };
  }

  async executeCommand(commandId, input, options = {}) {
    if (!commandId) throw new TypeError("commandId is required");
    if (typeof this.commandExecutor === "function") return this.commandExecutor(commandId, input, { ...options, source: options.source ?? `host:${this.kind}` });
    if (typeof this.core?.commands?.execute === "function") return this.core.commands.execute(commandId, input, { ...options, source: options.source ?? `host:${this.kind}` });
    if (typeof this.core?.executeCommand === "function") return this.core.executeCommand(commandId, input, options);
    throw new HostAdapterError("COMMAND_UNAVAILABLE", `No command executor is attached for ${commandId}`, { commandId });
  }

  async _dispatch(definition, payload, source, metadata = {}) {
    if (typeof definition.handler === "function") return definition.handler(payload, { source, host: this, definition, metadata });
    return this.executeCommand(definition.commandId, payload, { source, metadata });
  }

  async dispatchGlobalHotkey(bindingOrId, payload) {
    const definition = this.hotkeys.get(bindingOrId) ?? [...this.hotkeys.values()].find((item) => item.binding === bindingOrId);
    if (!definition) throw new HostAdapterError("NOT_REGISTERED", `Global hotkey not registered: ${bindingOrId}`, { binding: bindingOrId });
    const result = await this._dispatch(definition, payload, "host:global-hotkey", { binding: definition.binding });
    await this.emit(HostEvent.HOTKEY, { id: definition.id, binding: definition.binding, result, payload });
    return result;
  }

  async triggerQuickTile(idOrCommand, payload) {
    const definition = this.quickTiles.get(idOrCommand);
    if (!definition) throw new HostAdapterError("NOT_REGISTERED", `Quick Tile not registered: ${idOrCommand}`, { id: idOrCommand });
    const result = await this._dispatch(definition, payload, "host:quick-tile");
    await this.emit(HostEvent.QUICK_TILE, { id: definition.id, result, payload });
    return result;
  }

  async receiveShare(payload, targetId) {
    const definition = targetId ? this.shareTargets.get(targetId) : this.shareTargets.values().next().value;
    if (!definition) throw new HostAdapterError("NOT_REGISTERED", "No share target is registered", { targetId });
    const result = await this._dispatch(definition, payload, "host:share-target");
    await this.emit(HostEvent.SHARE, { id: definition.id, result, payload });
    return result;
  }

  async showNotification(notification = {}) {
    this._require(HostCapability.NOTIFICATIONS, "Notification");
    const normalized = { id: notification.id ?? id("notification"), title: String(notification.title ?? "PAB"), body: String(notification.body ?? notification.message ?? ""), ...clone(notification) };
    this.notifications.set(normalized.id, normalized);
    const nativeResult = await this.invoke(HOST_METHOD.NOTIFY, normalized);
    // Browser fallback is intentionally opt-in. Native hosts own notification
    // permissions; silently opening a browser notification would violate that.
    if (nativeResult === undefined && notification.browserFallback === true && typeof globalThis.Notification === "function" && globalThis.Notification.permission === "granted") {
      try { new globalThis.Notification(normalized.title, { body: normalized.body, tag: normalized.id }); } catch { /* no-op */ }
    }
    return normalized;
  }

  async dismissNotification(notificationId) {
    this.notifications.delete(notificationId);
    return this.invoke(HOST_METHOD.NOTIFY_DISMISS, { id: notificationId });
  }

  async handleHostMessage(message) {
    const normalized = normalizeMessage(message);
    if (!normalized) return undefined;
    try {
      switch (normalized.type) {
        case HostEvent.HOTKEY: return this.dispatchGlobalHotkey(normalized.id ?? normalized.binding, normalized.payload);
        case HostEvent.QUICK_TILE: return this.triggerQuickTile(normalized.id, normalized.payload);
        case HostEvent.SHARE: return this.receiveShare(normalized.payload, normalized.id);
        case HostEvent.NOTIFICATION_ACTION: return this.emit(HostEvent.NOTIFICATION_ACTION, normalized.payload);
        case HostEvent.RESPONSE: return this.emit(HostEvent.RESPONSE, normalized.payload);
        case HostEvent.ERROR: return this.emit(HostEvent.ERROR, normalized.payload);
        default: return this.emit(normalized.type, normalized.payload);
      }
    } catch (error) {
      await this.emit(HostEvent.ERROR, { sourceEvent: normalized.type, error: serializeError(error), payload: normalized.payload });
      throw error;
    }
  }
}

function publicDefinition(definition) {
  const { handler, ...publicValue } = definition;
  return publicValue;
}

function serializeError(error) { return { name: error?.name ?? "Error", code: error?.code, message: String(error?.message ?? error) }; }

function normalizeMessage(message) {
  if (!message) return undefined;
  let value = message?.data ?? message;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== "object") return undefined;
  const rawType = value.type ?? value.event ?? value.kind;
  const aliases = {
    "pab.hotkey": HostEvent.HOTKEY,
    "pab.host.hotkey": HostEvent.HOTKEY,
    "pab.quickTile": HostEvent.QUICK_TILE,
    "pab.host.quick_tile": HostEvent.QUICK_TILE,
    "pab.share": HostEvent.SHARE,
    "pab.host.share_target": HostEvent.SHARE,
    "pab.notification.action": HostEvent.NOTIFICATION_ACTION,
    "pab.host.response": HostEvent.RESPONSE,
    "pab.host.error": HostEvent.ERROR,
  };
  return { ...value, type: aliases[rawType] ?? rawType, id: value.id ?? value.targetId, payload: value.payload ?? value.data };
}

/** Base Windows adapter. It only assumes a transport; no Tauri/WebView2 SDK. */
export class WindowsHostAdapter extends HostAdapter {
  constructor(options = {}) {
    super({ ...options, platform: "windows", capabilities: { globalHotkey: true, quickTile: false, shareTarget: false, notifications: true, persistentStorage: true, ...(options.capabilities ?? {}) } });
  }
}

/** Base Android adapter. Quick Tile and Share Target are native hooks. */
export class AndroidHostAdapter extends HostAdapter {
  constructor(options = {}) {
    super({ ...options, platform: "android", capabilities: { globalHotkey: false, quickTile: true, shareTarget: true, notifications: true, persistentStorage: true, ...(options.capabilities ?? {}) } });
  }
}

/**
 * WebView2 transport. The native host receives `pab.host.request` messages.
 * It may send responses/events back through the WebView2 `message` event.
 */
export function createWebView2Transport(webview = globalThis.chrome?.webview) {
  return {
    kind: "webview2",
    invoke(method, payload) {
      if (typeof webview?.postMessage !== "function") return undefined;
      const requestId = id("host_req");
      webview.postMessage({ type: "pab.host.request", requestId, method, payload: clone(payload) });
      return { requestId, dispatched: true };
    },
    onMessage(handler) {
      if (typeof webview?.addEventListener !== "function") return () => {};
      const listener = (event) => handler(event?.data ?? event);
      webview.addEventListener("message", listener);
      return () => webview.removeEventListener?.("message", listener);
    },
  };
}

/** Tauri transport using the injected `core.invoke` or legacy `invoke`. */
export function createTauriTransport(tauri = globalThis.__TAURI__) {
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  return {
    kind: "tauri",
    invoke(method, payload) {
      if (typeof invoke !== "function") return undefined;
      return invoke.call(tauri?.core ?? tauri, `pab_${method.replace(/[^a-zA-Z0-9]+/g, "_")}`, clone(payload));
    },
    onMessage(handler) {
      const eventApi = tauri?.event;
      if (typeof eventApi?.listen !== "function") return () => {};
      let unlisten;
      Promise.resolve(eventApi.listen("pab-host-message", (event) => handler(event?.payload ?? event))).then((value) => { unlisten = value; });
      return () => { if (typeof unlisten === "function") unlisten(); };
    },
  };
}

/** Generic Android WebView transport using a JS interface/postMessage hook. */
export function createAndroidWebViewTransport(android = globalThis.PABAndroid ?? globalThis.Android, windowObject = globalThis.window) {
  return {
    kind: "android-webview",
    invoke(method, payload) {
      const message = JSON.stringify({ type: "pab.host.request", requestId: id("host_req"), method, payload: clone(payload) });
      if (typeof android?.postMessage === "function") { android.postMessage(message); return { dispatched: true }; }
      if (typeof android?.invoke === "function") return android.invoke(method, clone(payload));
      if (typeof windowObject?.PABAndroid?.postMessage === "function") { windowObject.PABAndroid.postMessage(message); return { dispatched: true }; }
      return undefined;
    },
    onMessage(handler) {
      if (typeof windowObject?.addEventListener !== "function") return () => {};
      const listener = (event) => handler(event?.data ?? event);
      windowObject.addEventListener("message", listener);
      return () => windowObject.removeEventListener?.("message", listener);
    },
  };
}

/** Capacitor transport. The optional plugin defaults to `PABHost`. */
export function createCapacitorTransport(capacitor = globalThis.Capacitor, options = {}) {
  const pluginName = options.pluginName ?? "PABHost";
  const plugin = capacitor?.Plugins?.[pluginName] ?? options.plugin;
  return {
    kind: "capacitor",
    async invoke(method, payload) {
      if (typeof plugin?.invoke === "function") return plugin.invoke({ method, payload: clone(payload) });
      const camel = method.replace(/\.([a-z])/g, (_, char) => char.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
      if (typeof plugin?.[camel] === "function") return plugin[camel](clone(payload));
      return undefined;
    },
    onMessage(handler) {
      if (typeof plugin?.addListener !== "function") return () => {};
      let remove;
      Promise.resolve(plugin.addListener(options.eventName ?? "pabHostMessage", (event) => handler(event?.payload ?? event))).then((subscription) => {
        remove = subscription?.remove;
      });
      return () => { if (typeof remove === "function") remove(); };
    },
  };
}

export class WindowsWebView2Adapter extends WindowsHostAdapter {
  constructor(options = {}) { super({ ...options, kind: "webview2", bridge: options.bridge ?? options.transport ?? createWebView2Transport(options.webview) }); }
}

export class WindowsTauriAdapter extends WindowsHostAdapter {
  constructor(options = {}) { super({ ...options, kind: "tauri", bridge: options.bridge ?? options.transport ?? createTauriTransport(options.tauri) }); }
}

export class AndroidWebViewAdapter extends AndroidHostAdapter {
  constructor(options = {}) { super({ ...options, kind: "android-webview", bridge: options.bridge ?? options.transport ?? createAndroidWebViewTransport(options.android, options.windowObject) }); }
}

export class AndroidCapacitorAdapter extends AndroidHostAdapter {
  constructor(options = {}) { super({ ...options, kind: "capacitor", bridge: options.bridge ?? options.transport ?? createCapacitorTransport(options.capacitor, options) }); }
}

export const createWindowsWebView2Adapter = (options = {}) => new WindowsWebView2Adapter(options);
export const createWindowsTauriAdapter = (options = {}) => new WindowsTauriAdapter(options);
export const createAndroidWebViewAdapter = (options = {}) => new AndroidWebViewAdapter(options);
export const createAndroidCapacitorAdapter = (options = {}) => new AndroidCapacitorAdapter(options);

/**
 * Choose a native adapter from an explicit host kind. Detection is purposely
 * conservative; callers can always inject a bridge and avoid probing globals.
 */
export function createHostAdapter(options = {}) {
  const platform = options.platform ?? detectPlatform();
  const kind = options.kind ?? detectHostKind(platform);
  if (platform === "windows" && kind === "tauri") return createWindowsTauriAdapter(options);
  if (platform === "windows") return createWindowsWebView2Adapter(options);
  if (platform === "android" && kind === "capacitor") return createAndroidCapacitorAdapter(options);
  if (platform === "android") return createAndroidWebViewAdapter(options);
  return new HostAdapter({ ...options, platform, kind });
}

export function detectPlatform() {
  const userAgent = String(globalThis.navigator?.userAgent ?? "").toLowerCase();
  if (userAgent.includes("android")) return "android";
  if (userAgent.includes("windows")) return "windows";
  if (userAgent.includes("mac os")) return "macos";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
}

export function detectHostKind(platform = detectPlatform()) {
  if (platform === "windows" && globalThis.__TAURI__) return "tauri";
  if (platform === "android" && globalThis.Capacitor) return "capacitor";
  if (platform === "windows" && globalThis.chrome?.webview) return "webview2";
  return "generic";
}
