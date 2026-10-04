import { randomId } from "./util.js";

/** Minimal local-first memory repository; hosts can swap in SQLite while the
 * Ability SDK keeps the same query/write contract. */
export class MemoryRepository {
  constructor({ storage, clock = () => Date.now() } = {}) {
    this.storage = storage;
    this.clock = clock;
    this.items = new Map();
    this.loaded = false;
  }
  async load() {
    if (this.loaded) return;
    const records = await this.storage?.get("entries", []);
    for (const item of records ?? []) this.items.set(item.id, item);
    this.loaded = true;
  }
  async persist() { await this.storage?.set("entries", [...this.items.values()]); }
  /** Synchronous fast path used by the in-memory/browser runtime after load(). */
  writeSync(entry) {
    if (!this.loaded) throw new Error("MemoryRepository is not loaded; call load() before using writeSync().");
    const now = this.clock();
    const content = entry.content ?? entry.text ?? "";
    const item = { id: entry.id ?? randomId("mem"), type: entry.type ?? "note", content, text: entry.text ?? content, tags: [...(entry.tags ?? [])], metadata: { ...(entry.metadata ?? {}) }, createdAt: entry.createdAt ?? now, updatedAt: now, source: entry.source ?? "core" };
    this.items.set(item.id, item);
    return structuredCloneSafe(item);
  }
  async write(entry) { await this.load(); const item = this.writeSync(entry); await this.persist(); return item; }
  async get(id) { await this.load(); return structuredCloneSafe(this.items.get(id)); }
  async delete(id) { await this.load(); const result = this.items.delete(id); if (result) await this.persist(); return result; }
  querySync(query = {}) {
    if (!this.loaded) throw new Error("MemoryRepository is not loaded; call load() before using querySync().");
    const text = String(query.text ?? "").toLowerCase();
    const tags = new Set(query.tags ?? []);
    const result = [...this.items.values()].filter((item) => {
      if (query.type && item.type !== query.type) return false;
      if (query.source && item.source !== query.source && item.metadata?.abilityId !== query.source) return false;
      if (tags.size && ![...tags].every((tag) => item.tags.includes(tag))) return false;
      if (text && !`${item.content} ${item.text ?? ""} ${item.tags.join(" ")} ${JSON.stringify(item.metadata)}`.toLowerCase().includes(text)) return false;
      if (query.after && item.updatedAt < query.after) return false;
      if (query.before && item.updatedAt > query.before) return false;
      return true;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    return result.slice(0, query.limit ?? 100).map(structuredCloneSafe);
  }
  async query(query = {}) { await this.load(); return this.querySync(query); }
  async all() { return this.query({ limit: Number.MAX_SAFE_INTEGER }); }
  async deleteBySource(source) {
    await this.load();
    const ids = [...this.items.values()].filter((item) => item.source === source || item.metadata?.abilityId === source).map((item) => item.id);
    for (const id of ids) this.items.delete(id);
    if (ids.length) await this.persist();
    return ids.length;
  }
}

function structuredCloneSafe(value) {
  if (value === undefined) return undefined;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
