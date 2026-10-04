import { PabError, ErrorCode } from "./errors.js";
import { clone, randomId } from "./util.js";

/** Lightweight context presets. Switching a loadout never uninstalls modules. */
export class LoadoutManager {
  constructor({ storage, eventBus, clock = () => Date.now() } = {}) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.clock = clock;
    this.loadouts = new Map();
    this.activeId = null;
    this.loaded = false;
  }
  async load() {
    if (this.loaded) return;
    const saved = await this.storage?.get("records", {});
    for (const [id, value] of Object.entries(saved?.loadouts ?? {})) this.loadouts.set(id, normalise(id, value));
    this.activeId = saved?.activeId ?? [...this.loadouts.keys()][0] ?? null;
    this.loaded = true;
  }
  async persist() { await this.storage?.set("records", { activeId: this.activeId, loadouts: Object.fromEntries(this.loadouts) }); }
  async list() { await this.load(); return [...this.loadouts.values()].map(clone); }
  async get(id) { await this.load(); return clone(this.loadouts.get(id)); }
  async active() { await this.load(); return clone(this.loadouts.get(this.activeId)); }
  async create(input = {}) {
    await this.load();
    const id = input.id ?? randomId("loadout");
    if (this.loadouts.has(id)) throw new PabError(ErrorCode.INVALID_STATE, `Loadout already exists: ${id}`);
    const item = normalise(id, input);
    this.loadouts.set(id, item);
    if (!this.activeId) this.activeId = id;
    await this.persist();
    await this.eventBus?.publish("loadout.created", { loadout: clone(item) }, { source: "core" });
    return clone(item);
  }
  async update(id, patch) {
    await this.load();
    const current = this.require(id);
    const item = normalise(id, { ...current, ...patch, updatedAt: this.clock() });
    this.loadouts.set(id, item);
    await this.persist();
    await this.eventBus?.publish("loadout.updated", { loadout: clone(item) }, { source: "core" });
    return clone(item);
  }
  async activate(id) {
    await this.load();
    const item = this.require(id);
    this.activeId = id;
    await this.persist();
    await this.eventBus?.publish("loadout.activated", { loadout: clone(item) }, { source: "core" });
    return clone(item);
  }
  async remove(id) {
    await this.load();
    this.require(id);
    this.loadouts.delete(id);
    if (this.activeId === id) this.activeId = [...this.loadouts.keys()][0] ?? null;
    await this.persist();
    await this.eventBus?.publish("loadout.removed", { id }, { source: "core" });
  }
  require(id) {
    const item = this.loadouts.get(id);
    if (!item) throw new PabError(ErrorCode.INVALID_STATE, `Loadout not found: ${id}`, { id });
    return item;
  }
}

function normalise(id, value = {}) {
  return {
    id,
    name: value.name ?? id,
    description: value.description ?? "",
    icon: value.icon ?? "⌘",
    abilityIds: [...new Set(value.abilityIds ?? [])],
    visible: value.visible !== false,
    order: Number.isFinite(value.order) ? value.order : 0,
    createdAt: value.createdAt ?? Date.now(),
    updatedAt: value.updatedAt ?? Date.now(),
  };
}

