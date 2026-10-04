/**
 * Storage contracts deliberately use async methods. The in-memory adapter is
 * used in tests and first-run mode; Windows can provide a SQLite-backed
 * adapter and Android can provide a Room/SQLite bridge without changing an
 * Ability's code.
 */

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export class MemoryStorage {
  constructor(initial = {}) {
    const seed = clone(initial ?? {});
    this.values = new Map(Object.entries(seed && typeof seed === "object" ? seed : {}));
  }

  // MemoryStorage is deliberately synchronous.  Core still awaits these
  // methods where it talks to an async adapter, while the portable Ability
  // SDK can use the same API from a command handler without receiving a
  // Promise unexpectedly.  Native SQLite/Room adapters may remain async.
  get(key, fallback = undefined) { return clone(this.values.has(String(key)) ? this.values.get(String(key)) : fallback); }
  set(key, value) { this.values.set(String(key), clone(value)); }
  delete(key) { return this.values.delete(String(key)); }
  has(key) { return this.values.has(String(key)); }
  keys(prefix = "") { return [...this.values.keys()].filter((key) => key.startsWith(prefix)); }
  clear(prefix = "") {
    for (const key of this.keys(prefix)) this.values.delete(key);
  }
  entries(prefix = "") { return this.keys(prefix).map((key) => [key, clone(this.values.get(key))]); }
}

/** Wrap any key-value adapter in an isolated namespace. */
export class NamespacedStorage {
  constructor(storage, namespace) {
    if (!storage) throw new TypeError("A storage adapter is required");
    this.storage = storage;
    this.namespace = String(namespace).replace(/\/+$/, "");
  }
  key(key) { return `${this.namespace}/${String(key).replace(/^\/+/, "")}`; }
  get(key, fallback) { return this.storage.get(this.key(key), fallback); }
  set(key, value) { return this.storage.set(this.key(key), value); }
  delete(key) { return this.storage.delete(this.key(key)); }
  has(key) { return this.storage.has(this.key(key)); }
  keys() {
    const keys = this.storage.keys(`${this.namespace}/`);
    return typeof keys?.then === "function"
      ? keys.then((items) => items.map((key) => key.slice(this.namespace.length + 1)))
      : keys.map((key) => key.slice(this.namespace.length + 1));
  }
  entries() {
    const entries = typeof this.storage.entries === "function"
      ? this.storage.entries(`${this.namespace}/`)
      : Promise.resolve(this.storage.keys(`${this.namespace}/`)).then(async (keys) => Promise.all(keys.map(async (key) => [key, await this.storage.get(key)])));
    const map = (items) => items.map(([key, value]) => [key.slice(this.namespace.length + 1), value]);
    return typeof entries?.then === "function" ? entries.then(map) : map(entries);
  }
  clear() { return this.storage.clear(`${this.namespace}/`); }
}

/**
 * A serialisable JSON adapter useful when a host owns persistence (for
 * example, a SQLite row or Android DataStore). `read` and `write` receive or
 * return the complete object, making atomic persistence straightforward.
 */
export class JsonStorage {
  /** @param {{read:()=>Promise<object|string|null>|object|string|null,write:(value:object)=>Promise<void>|void}} io */
  constructor(io) {
    if (!io || typeof io.read !== "function" || typeof io.write !== "function") throw new TypeError("JsonStorage requires read and write functions");
    this.io = io;
    this.loaded = false;
    this.values = {};
  }
  async load() {
    if (this.loaded) return;
    const raw = await this.io.read();
    if (typeof raw === "string") {
      try { this.values = JSON.parse(raw) ?? {}; } catch { this.values = {}; }
    } else this.values = raw && typeof raw === "object" ? clone(raw) : {};
    this.loaded = true;
  }
  async flush() { await this.io.write(clone(this.values)); }
  async get(key, fallback) { await this.load(); return clone(Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : fallback); }
  async set(key, value) { await this.load(); this.values[key] = clone(value); await this.flush(); }
  async delete(key) { await this.load(); const existed = Object.prototype.hasOwnProperty.call(this.values, key); delete this.values[key]; if (existed) await this.flush(); return existed; }
  async has(key) { await this.load(); return Object.prototype.hasOwnProperty.call(this.values, key); }
  async keys(prefix = "") { await this.load(); return Object.keys(this.values).filter((key) => key.startsWith(prefix)); }
  async entries(prefix = "") { await this.load(); return Object.entries(this.values).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)]); }
  async clear(prefix = "") { await this.load(); for (const key of Object.keys(this.values)) if (key.startsWith(prefix)) delete this.values[key]; await this.flush(); }
}

/** Names used by Core; keeping these stable allows future migrations. */
export const StorageNamespace = Object.freeze({
  CORE: "core",
  MODULES: "core/modules",
  MODULE_STATE: "core/module-state",
  PERMISSIONS: "core/permissions",
  REGISTRY: "core/registry",
  USERDATA: "userdata",
  SETTINGS: "core/settings",
  LOGS: "core/logs",
});
