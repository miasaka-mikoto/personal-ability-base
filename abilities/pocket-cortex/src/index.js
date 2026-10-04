import { defineAbility } from "@pab/ability-sdk";

const makeEntry = (text, tags = []) => ({ text: String(text).trim(), tags, source: "pocket-cortex" });

const ability = defineAbility({
  activate(api) {
    const refresh = async () => {
      const recent = await api.memory.query({ limit: 8 });
      api.publishEvent("memory.updated", { abilityId: api.manifest.id, count: Array.isArray(recent) ? recent.length : 0 });
      return recent;
    };
    api.registerPage({ id: "pocket-cortex.home", title: "Pocket Cortex", route: "/abilities/pocket-cortex", render: () => ({ type: "memory-list" }) });
    api.registerCard({ id: "pocket-cortex.recent", title: "Recent memories", refresh, render: () => refresh() });
    api.registerCommand({
      id: "pocket-cortex.capture",
      title: "Capture memory",
      description: "Save a thought to your private memory store.",
      execute: async ({ text, tags } = {}) => {
        if (!text || !String(text).trim()) throw new Error("Capture requires text.");
        const entry = await api.memory.write(makeEntry(text, tags));
        await api.publishEvent("memory.created", entry);
        api.showNotification({ title: "Memory captured", body: String(text).slice(0, 80), level: "success" });
        return entry;
      }
    });
    api.registerCommand({
      id: "pocket-cortex.recall",
      title: "Recall memory",
      description: "Search memories by text or tags.",
      execute: async (query = {}) => api.memory.query(query)
    });
    api.registerSearchProvider({ id: "pocket-cortex.search", search: async (query) => api.memory.query({ text: query, limit: 20 }) });
    api.subscribeEvent("capture.created", async (capture, envelope) => {
      // Capture Everything (and other producers) may already have persisted
      // the memory before publishing the bus event. Do not create a second
      // copy when the event carries that durable linkage marker.
      const source = envelope?.source ?? envelope?.sourceAbilityId;
      const hostOwned = typeof source === "string" && (/^(android|windows)([.:]|$)/i.test(source) || /^host:/i.test(source));
      const alreadyWritten = Boolean(capture?.memoryId || capture?.memoryWritten || capture?.metadata?.memoryWritten);
      if (capture?.text && !alreadyWritten && !hostOwned) await api.memory.write(makeEntry(capture.text, capture.tags ?? ["capture"]));
    });
    api.subscribeEvent("memory.query", async (query) => api.publishEvent("memory.query.result", await api.memory.query(query ?? {})));
    return { refresh };
  },
  deactivate(api) { api.log("info", "Pocket Cortex deactivated"); }
});

// Named lifecycle exports keep the package compatible with minimal hosts;
// the default callable export is the canonical SDK form.
export const activate = ability;
export const deactivate = ability.deactivate;
export default ability;
