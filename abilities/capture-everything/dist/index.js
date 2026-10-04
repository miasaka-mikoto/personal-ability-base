import { defineAbility } from "@pab/ability-sdk";

const ABILITY_SOURCE = "capture-everything";
const DEFAULT_LIMIT = 200;

function makeId(prefix = "cap") {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normaliseTags(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(asText).filter(Boolean))].slice(0, 32);
}

function normaliseInput(input = {}) {
  if (typeof input === "string") return { text: asText(input), tags: [] };
  if (!input || typeof input !== "object") return { text: "", tags: [] };
  const text = asText(input.text ?? input.content ?? input.body ?? input.sharedText ?? input.clipboardText ?? input.url);
  const title = asText(input.title);
  const tags = normaliseTags(input.tags);
  const channel = asText(input.channel ?? input.sourceChannel ?? (input.url ? "share" : "quick")) || "quick";
  const source = asText(input.source ?? input.origin ?? "user") || "user";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.filter((item) => item && typeof item === "object").slice(0, 16)
    : [];
  return {
    id: asText(input.id) || undefined,
    text,
    title,
    tags,
    channel,
    source,
    createdAt,
    attachments,
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {}
  };
}

function matchesCapture(item, query = {}) {
  const text = asText(query.text).toLowerCase();
  if (text && !`${item.text} ${item.title} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(text)) return false;
  if (query.channel && item.channel !== query.channel) return false;
  if (query.status && item.status !== query.status) return false;
  const tags = normaliseTags(query.tags);
  if (tags.length && !tags.every((tag) => (item.tags ?? []).includes(tag))) return false;
  return true;
}

function sortNewest(items) {
  return [...items].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Capture Everything is deliberately host-neutral. Windows global hotkeys,
 * Android Share Targets, Quick Tiles, and notification actions all call the
 * same `capture-everything.capture` command or publish `capture.created`.
 */
const ability = defineAbility({
  async activate(api) {
    let captures = await api.storage.get("captures", []);
    if (!Array.isArray(captures)) captures = [];
    // Core's native context exposes namespaced `settings`, while the SDK test
    // adapter exposes `getSettings()`. Support both without importing a host
    // implementation or assuming synchronous storage.
    let settings = api.settings?.get
      ? await api.settings.get("value", {})
      : await api.getSettings?.();
    if (!settings || typeof settings !== "object") settings = {};
    let queue = Promise.resolve();

    const runExclusive = (operation) => {
      const next = queue.then(operation, operation);
      queue = next.catch(() => undefined);
      return next;
    };

    const getLimit = () => {
      const value = Number(settings.retentionLimit ?? DEFAULT_LIMIT);
      return Number.isInteger(value) && value >= 10 && value <= 10_000 ? value : DEFAULT_LIMIT;
    };

    const persist = async () => {
      captures = sortNewest(captures).slice(0, getLimit());
      await api.storage.set("captures", captures);
      await api.storage.set("captureCount", captures.length);
      await api.storage.set("lastCapture", captures[0] ?? null);
      return captures;
    };

    const queryInbox = async (query = {}) => {
      const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, getLimit()));
      return sortNewest(captures.filter((item) => matchesCapture(item, query))).slice(0, limit);
    };

    const buildMemoryEntry = (capture) => ({
      type: "capture",
      text: capture.text,
      title: capture.title || undefined,
      tags: ["capture", ...capture.tags],
      source: ABILITY_SOURCE,
      metadata: {
        ...capture.metadata,
        captureId: capture.id,
        channel: capture.channel,
        origin: capture.source,
        captureEverything: true
      }
    });

    const saveCapture = async (input, { fromEvent = false, skipMemory = false } = {}) => {
      const normalised = normaliseInput(input);
      if (!normalised.text) throw new Error("Capture requires text, content, or a shared URL.");
      const duplicate = normalised.id ? captures.find((item) => item.id === normalised.id) : undefined;
      if (duplicate) return duplicate;

      const defaultTags = normaliseTags(settings.defaultTags ?? ["inbox"]);
      const capture = {
        id: normalised.id ?? makeId(),
        text: normalised.text,
        title: normalised.title,
        tags: normaliseTags([...defaultTags, ...normalised.tags]),
        channel: normalised.channel,
        source: normalised.source,
        attachments: normalised.attachments,
        createdAt: normalised.createdAt,
        updatedAt: new Date().toISOString(),
        status: "inbox",
        metadata: { ...normalised.metadata, fromEvent }
      };

      let memory;
      if (skipMemory && input?.memoryId) memory = { id: input.memoryId };
      else if (!skipMemory) memory = await api.memory.write(buildMemoryEntry(capture));

      const saved = {
        ...capture,
        memoryId: memory?.id ?? input?.memoryId,
        memoryWritten: Boolean(memory?.id || input?.memoryWritten),
        status: "captured"
      };
      captures = [saved, ...captures.filter((item) => item.id !== saved.id)];
      await persist();

      // `source` is supplied by the Runtime as this Ability, so our own
      // capture.created subscription ignores this event and cannot recurse.
      await api.publishEvent("capture.created", {
        ...saved,
        metadata: { ...saved.metadata, captureId: saved.id, memoryWritten: saved.memoryWritten },
        memoryId: saved.memoryId,
        memoryWritten: saved.memoryWritten
      });
      await api.publishEvent("capture.saved", saved);
      api.showNotification({ title: "Captured", body: saved.title || saved.text.slice(0, 96), level: "success" });
      return saved;
    };

    const quickCapture = async (input = {}) => {
      // Native adapters may provide clipboard contents through a controlled
      // request. The normal path remains payload-based for offline/runtime
      // portability and Android Share Target support.
      if (input && typeof input === "object" && input.fromClipboard && !asText(input.text ?? input.content ?? input.clipboardText)) {
        const clipboard = await api.request("clipboard.read", {});
        input = { ...input, text: clipboard?.text ?? clipboard?.content ?? clipboard };
      }
      return runExclusive(() => saveCapture(input));
    };

    const listCaptures = (query = {}) => queryInbox(query);

    api.registerPage({
      id: "capture-everything.inbox",
      title: "Capture Everything",
      route: "/abilities/capture-everything",
      render: () => queryInbox({ limit: 50 })
    });
    api.registerCard({
      id: "capture-everything.inbox",
      title: "Capture inbox",
      render: () => queryInbox({ limit: 5 })
    });
    api.registerCommand({
      id: "capture-everything.capture",
      title: "Quick capture",
      description: "Save a thought, link, or shared item locally.",
      execute: quickCapture
    });
    api.registerCommand({
      id: "capture-everything.quick-capture",
      title: "Quick capture (share/hotkey)",
      description: "Entry point for Windows hotkeys and Android Share Targets.",
      execute: quickCapture
    });
    api.registerCommand({
      id: "capture-everything.list",
      title: "Open capture inbox",
      description: "List locally captured items.",
      execute: listCaptures
    });
    api.registerSearchProvider({
      id: "capture-everything.search",
      search: async (query) => queryInbox({ text: query, limit: 20 })
    });

    api.subscribeEvent("capture.created", (payload, envelope) => {
      const source = envelope?.source ?? envelope?.sourceAbilityId;
      if (source === api.manifest.id || payload?.metadata?.captureEverythingHandled) return;
      if (!payload || typeof payload !== "object") return;
      return runExclusive(() => saveCapture(payload, {
        fromEvent: true,
        skipMemory: Boolean(payload.memoryId || payload.memoryWritten)
      }));
    });
    api.subscribeEvent("memory.created", (payload) => {
      // Keep a lightweight linkage for host adapters that write memory first.
      // We do not copy arbitrary memory into the capture inbox.
      if (payload?.metadata?.captureId && !captures.some((item) => item.id === payload.metadata.captureId)) {
        api.log("debug", "Memory references an unknown capture", { captureId: payload.metadata.captureId });
      }
    });

    return {
      quickCapture,
      list: listCaptures,
      getLastCapture: () => captures[0] ?? null,
      getCount: () => captures.length
    };
  },
  async deactivate(api) {
    api.log("info", "Capture Everything deactivated");
  }
});

export const activate = ability;
export const deactivate = ability.deactivate;
export default ability;
