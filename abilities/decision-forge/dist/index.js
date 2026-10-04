import { defineAbility } from "@pab/ability-sdk";

const decisionEntry = (decision) => ({
  text: `Decision: ${decision.question}\nChosen: ${decision.choice}`,
  tags: ["decision", ...(decision.tags ?? [])],
  source: "decision-forge",
  metadata: { decision }
});

const ability = defineAbility({
  activate(api) {
    const open = async () => api.storage.get("open", []);
    const save = (items) => api.storage.set("open", items);
    api.registerPage({ id: "decision-forge.home", title: "Decision Forge", route: "/abilities/decision-forge", render: () => open() });
    api.registerCard({ id: "decision-forge.open", title: "Open decisions", render: () => open() });
    api.registerCommand({
      id: "decision-forge.create",
      title: "Create decision",
      execute: async (input = {}) => {
        if (!input.question || !input.choice) throw new Error("A decision requires question and choice.");
        const item = { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, question: String(input.question), choice: String(input.choice), options: input.options ?? [], status: "open", createdAt: new Date().toISOString() };
        save([...(await open()), item]);
        await api.memory.write(decisionEntry(item));
        await api.publishEvent("decision.created", item);
        return item;
      }
    });
    api.registerCommand({
      id: "decision-forge.review",
      title: "Review decision",
      execute: async ({ id, outcome, notes } = {}) => {
        const items = await open();
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) throw new Error(`Decision not found: ${id}`);
        const item = { ...items[index], status: "reviewed", outcome, notes, reviewedAt: new Date().toISOString() };
        items[index] = item; await save(items);
        await api.publishEvent("decision.reviewed", item);
        api.showNotification({ title: "Decision reviewed", body: item.question, level: "success" });
        return item;
      }
    });
    api.registerSearchProvider({ id: "decision-forge.search", search: async (query) => (await open()).filter((item) => JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase())) });
    api.subscribeEvent("decision.created", (item) => api.log("info", "Decision created", { id: item?.id }));
  },
  deactivate(api) { api.log("info", "Decision Forge deactivated"); }
});

export const activate = ability;
export const deactivate = ability.deactivate;
export default ability;
