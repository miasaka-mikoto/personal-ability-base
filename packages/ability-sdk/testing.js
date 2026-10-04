import { randomUUID } from "node:crypto";

/** A tiny deterministic in-memory runtime for SDK tests and local development. */
export function createTestRuntime(options = {}) {
  const events = new Map();
  const privateStore = new Map();
  const sharedStore = new Map();
  const memories = [];
  const settings = new Map();
  const notifications = [];
  const pages = [];
  const commands = new Map();
  const requests = new Map();
  const runtime = {
    version: options.version ?? "0.1.0-test",
    events,
    notifications,
    pages,
    commands,
    requests,
    memories,
    subscribeEvent(event, handler) {
      const set = events.get(event) ?? new Set();
      set.add(handler); events.set(event, set);
      return () => set.delete(handler);
    },
    publishEvent(event, payload, sourceAbilityId) {
      const envelope = { id: randomUUID(), event, payload, sourceAbilityId, timestamp: new Date().toISOString() };
      for (const handler of events.get(event) ?? []) handler(payload, envelope);
      for (const handler of events.get("*") ?? []) handler(payload, envelope);
      return envelope;
    },
    request() { return undefined; },
    openPage(pageId, params, sourceAbilityId) { const page = { pageId, params, sourceAbilityId }; pages.push(page); return page; },
    showNotification(notification) { notifications.push(notification); return notification; },
    registerCommand(definition) {
      const handler = definition.handler ?? definition.execute;
      if (!definition?.id || typeof handler !== "function") throw new TypeError("Test command requires id and execute/handler");
      commands.set(definition.id, { ...definition, handler });
      return () => commands.delete(definition.id);
    },
    registerRequest(definition) {
      const handler = definition.handler ?? definition.execute;
      if (!definition?.id || typeof handler !== "function") throw new TypeError("Test request requires id and execute/handler");
      requests.set(definition.id, { ...definition, handler });
      return () => requests.delete(definition.id);
    },
    request(name, payload, sourceAbilityId) {
      const request = requests.get(name);
      if (!request) throw new Error(`Request not found: ${name}`);
      return request.handler(payload, { request, source: sourceAbilityId ?? "test" });
    },
    async executeCommand(id, input) {
      const command = commands.get(id);
      if (!command) throw new Error(`Command not found: ${id}`);
      return command.handler(input, { command, source: "test" });
    },
    storageGet(abilityId, key, fallback) { return privateStore.get(`${abilityId}:${key}`) ?? fallback; },
    storageSet(abilityId, key, value) { privateStore.set(`${abilityId}:${key}`, value); return value; },
    storageDelete(abilityId, key) { return privateStore.delete(`${abilityId}:${key}`); },
    storageKeys(abilityId) { const prefix = `${abilityId}:`; return [...privateStore.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)); },
    sharedStorageGet(key, fallback) { return sharedStore.get(key) ?? fallback; },
    sharedStorageSet(key, value) { sharedStore.set(key, value); return value; },
    memoryQuery(query = {}) {
      let result = [...memories];
      if (query.text) result = result.filter((entry) => entry.text.toLowerCase().includes(String(query.text).toLowerCase()));
      if (query.tags?.length) result = result.filter((entry) => query.tags.every((tag) => entry.tags?.includes(tag)));
      return result.slice(0, query.limit ?? 50);
    },
    memoryWrite(entry, sourceAbilityId) { const saved = { ...entry, id: entry.id ?? randomUUID(), sourceAbilityId, createdAt: entry.createdAt ?? new Date().toISOString() }; memories.push(saved); return saved; },
    requestPermission(permission) { return options.grantedPermissions?.includes(permission) ?? false; },
    getSettings(abilityId) { return settings.get(abilityId) ?? {}; },
    setSettings(abilityId, value) { settings.set(abilityId, value); return value; },
    log(level, message, metadata) { options.logger?.({ level, message, metadata }); }
  };
  return runtime;
}
