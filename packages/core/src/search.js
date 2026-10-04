/** Unified search facade over Core memories and ability providers. */
export class SearchService {
  constructor({ memory, contributions, eventBus } = {}) {
    this.memory = memory;
    this.contributions = contributions;
    this.eventBus = eventBus;
  }
  async search(query, options = {}) {
    const text = String(query ?? "").trim();
    const results = [];
    if (!options.scope || options.scope === "memory") {
      for (const item of await this.memory?.query({ text, limit: options.limit ?? 50 }) ?? []) results.push({ kind: "memory", id: item.id, title: item.content?.slice(0, 120) ?? item.id, item, score: scoreText(item, text) });
    }
    if (!options.scope || options.scope === "abilities") {
      for (const provider of this.contributions?.list("searchProviders") ?? []) {
        if (typeof provider.search !== "function") continue;
        try {
          const values = await provider.search(text, options);
          for (const value of values ?? []) results.push({ ...value, kind: value.kind ?? "ability", abilityId: provider.abilityId, score: value.score ?? 0.5 });
        } catch (error) { await this.eventBus?.publish("search.provider.failed", { abilityId: provider.abilityId, error: String(error) }, { source: "core" }); }
      }
    }
    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, options.limit ?? 50);
  }
}

function scoreText(item, text) {
  if (!text) return 0.1;
  const haystack = `${item.content} ${item.tags?.join(" ") ?? ""}`.toLowerCase();
  return haystack === text.toLowerCase() ? 1 : haystack.startsWith(text.toLowerCase()) ? 0.8 : haystack.includes(text.toLowerCase()) ? 0.5 : 0.1;
}

