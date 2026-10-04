/**
 * The dashboard only talks to this small adapter.  A native shell (Tauri,
 * Capacitor, or the future PAB desktop/mobile shell) can implement the same
 * methods without changing the UI.  When a core bridge is exposed on
 * `window.PABCore`, it is used automatically; otherwise a local-first mock
 * keeps the prototype useful offline.
 */

export type Platform = "windows" | "android" | "linux" | "macos" | "ios";
export type AbilityStatus = "installed" | "available" | "update" | "disabled";

export interface AbilityManifest {
  schemaVersion: number;
  id: string;
  name: string;
  displayName: string;
  version: string;
  latestVersion?: string;
  description: string;
  longDescription: string;
  author: string;
  category: string;
  icon: string;
  accent: string;
  platforms: Platform[];
  permissions: string[];
  dependencies: Record<string, string>;
  contributes: { pages: number; commands: number; cards: number; workflows: number };
  tags: string[];
  status: AbilityStatus;
  featured?: boolean;
  installedAt?: string;
  dataRetained?: boolean;
  size: string;
}

export interface Loadout {
  id: string;
  name: string;
  description: string;
  icon: string;
  abilityIds: string[];
  active: boolean;
}

export interface ActivityItem {
  id: string;
  icon: string;
  title: string;
  description: string;
  time: string;
  tone: "green" | "blue" | "violet" | "amber";
}

export interface PabSnapshot {
  abilities: AbilityManifest[];
  loadouts: Loadout[];
  activeLoadoutId: string;
  activity: ActivityItem[];
}

export interface PabCoreBridge {
  getSnapshot?: () => Promise<Partial<PabSnapshot>> | Partial<PabSnapshot>;
  installAbility?: (id: string) => Promise<void>;
  disableAbility?: (id: string) => Promise<void>;
  enableAbility?: (id: string) => Promise<void>;
  uninstallAbility?: (id: string, keepData: boolean) => Promise<void>;
  updateAbility?: (id: string) => Promise<void>;
  activateLoadout?: (id: string) => Promise<void>;
  search?: (query: string) => Promise<unknown[]>;
}

declare global {
  interface Window {
    PABCore?: PabCoreBridge;
  }
}

const STORAGE_KEY = "pab.dashboard.snapshot.v1";

const seedAbilities: AbilityManifest[] = [
  {
    schemaVersion: 1,
    id: "com.pab.pocket-cortex",
    name: "Pocket Cortex",
    displayName: "袖珍记忆",
    version: "1.3.0",
    description: "Recall the details that matter, wherever you are.",
    longDescription: "A local-first memory layer for captures, people, projects, and the small details you do not want to lose.",
    author: "PAB Official",
    category: "Memory",
    icon: "◈",
    accent: "#8b7cff",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "memory.read", "memory.write"],
    dependencies: {},
    contributes: { pages: 2, commands: 4, cards: 2, workflows: 1 },
    tags: ["memory", "capture", "recall"],
    status: "installed",
    featured: true,
    installedAt: "2026-09-28T10:15:00Z",
    size: "4.8 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.skill-hud",
    name: "Skill HUD",
    displayName: "技能仪表盘",
    version: "1.1.0",
    description: "Turn repeatable actions into clear, executable protocols.",
    longDescription: "Build small workflows for the things you do often, then launch them from a command, hotkey, or card.",
    author: "PAB Official",
    category: "Execution",
    icon: "✦",
    accent: "#52d6bd",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "notifications"],
    dependencies: {},
    contributes: { pages: 3, commands: 7, cards: 3, workflows: 5 },
    tags: ["skills", "workflow", "protocol"],
    status: "installed",
    featured: true,
    installedAt: "2026-09-24T08:00:00Z",
    size: "2.1 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.decision-forge",
    name: "Decision Forge",
    displayName: "决策工坊",
    version: "1.4.0",
    latestVersion: "1.6.0",
    description: "Make difficult choices visible, comparable, and reviewable.",
    longDescription: "Frame a decision, weigh trade-offs, run scenarios, and keep a review trail so future-you can learn from the outcome.",
    author: "PAB Official",
    category: "Decision",
    icon: "◇",
    accent: "#ffb45e",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "memory.read", "memory.write"],
    dependencies: {},
    contributes: { pages: 2, commands: 3, cards: 2, workflows: 2 },
    tags: ["decision", "scenario", "review"],
    status: "update",
    featured: true,
    installedAt: "2026-09-21T14:30:00Z",
    size: "6.4 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.pocket-lab",
    name: "Pocket Lab",
    displayName: "口袋实验室",
    version: "0.8.2",
    description: "Run small experiments and see what actually changes.",
    longDescription: "A lightweight sandbox for hypotheses, variables, repeatable runs, and compact result summaries.",
    author: "PAB Official",
    category: "Thinking",
    icon: "⌬",
    accent: "#5da8ff",
    platforms: ["windows", "android"],
    permissions: ["storage.private"],
    dependencies: {},
    contributes: { pages: 2, commands: 4, cards: 2, workflows: 1 },
    tags: ["experiment", "thinking", "analysis"],
    status: "update",
    featured: true,
    installedAt: "2026-09-30T06:45:00Z",
    size: "3.7 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.conversation-gym",
    name: "Conversation Gym",
    displayName: "口语训练场",
    version: "1.0.0",
    description: "Practice useful conversations in short, repeatable sessions.",
    longDescription: "Scenario-based practice for languages and real-world conversations, with local progress tracking.",
    author: "PAB Community",
    category: "Learning",
    icon: "◌",
    accent: "#e77cff",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "microphone", "notifications"],
    dependencies: { "com.pab.pocket-cortex": ">=1.0.0" },
    contributes: { pages: 1, commands: 3, cards: 2, workflows: 2 },
    tags: ["language", "practice", "japanese"],
    status: "available",
    size: "8.2 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.capture-everything",
    name: "Capture Everything",
    displayName: "随手捕获",
    version: "0.1.0",
    description: "Capture an idea before it disappears.",
    longDescription: "Fast capture from the desktop, Android share sheet, or a global shortcut; route it later without breaking focus.",
    author: "PAB Official",
    category: "Perception",
    icon: "⊙",
    accent: "#f57486",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "memory.read", "memory.write", "clipboard", "notifications"],
    dependencies: {},
    contributes: { pages: 1, commands: 3, cards: 1, workflows: 2 },
    tags: ["capture", "inbox", "quick"],
    status: "available",
    size: "1.9 MB"
  },
  {
    schemaVersion: 1,
    id: "com.pab.personal-radar",
    name: "Personal Radar",
    displayName: "个人雷达",
    version: "0.5.0",
    description: "Surface the patterns and signals worth a second look.",
    longDescription: "A quiet review layer that brings related notes, unfinished threads, and recurring signals back to your attention.",
    author: "PAB Community",
    category: "Review",
    icon: "◉",
    accent: "#70c4ff",
    platforms: ["windows", "android"],
    permissions: ["storage.private", "memory.read"],
    dependencies: { "com.pab.pocket-cortex": ">=1.0.0" },
    contributes: { pages: 1, commands: 2, cards: 2, workflows: 1 },
    tags: ["review", "signals", "patterns"],
    status: "available",
    size: "2.7 MB"
  }
];

const seedLoadouts: Loadout[] = [
  { id: "daily", name: "Daily", description: "A calm default for everyday work.", icon: "☼", abilityIds: ["com.pab.pocket-cortex", "com.pab.skill-hud", "com.pab.capture-everything"], active: true },
  { id: "developer", name: "Developer", description: "Build, test, and debug without losing the thread.", icon: "⌘", abilityIds: ["com.pab.skill-hud", "com.pab.pocket-lab", "com.pab.personal-radar"], active: false },
  { id: "researcher", name: "Researcher", description: "Move from question to evidence to next experiment.", icon: "⌁", abilityIds: ["com.pab.pocket-cortex", "com.pab.pocket-lab", "com.pab.decision-forge"], active: false },
  { id: "japanese", name: "Japanese", description: "Short, focused language practice anywhere.", icon: "あ", abilityIds: ["com.pab.conversation-gym", "com.pab.pocket-cortex", "com.pab.skill-hud"], active: false }
];

const seedActivity: ActivityItem[] = [
  { id: "a1", icon: "✓", title: "Pocket Cortex installed", description: "Version 1.3.0 is ready to use", time: "18 min ago", tone: "green" },
  { id: "a2", icon: "↗", title: "Decision Forge update available", description: "1.4.0 → 1.6.0 · 6.4 MB", time: "42 min ago", tone: "amber" },
  { id: "a3", icon: "⌘", title: "Daily loadout activated", description: "3 abilities are in focus", time: "Today, 09:14", tone: "violet" },
  { id: "a4", icon: "⌁", title: "Registry refreshed", description: "12 official abilities · 8 community", time: "Yesterday", tone: "blue" }
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class LocalPabAdapter {
  private snapshot: PabSnapshot;
  private bridge: PabCoreBridge | undefined;

  constructor() {
    this.bridge = window.PABCore;
    const stored = this.readCache();
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<PabSnapshot>;
        if (Array.isArray(parsed.abilities) && Array.isArray(parsed.loadouts) && Array.isArray(parsed.activity)) {
          this.snapshot = {
            abilities: parsed.abilities,
            loadouts: parsed.loadouts,
            activeLoadoutId: parsed.activeLoadoutId ?? "daily",
            activity: parsed.activity
          };
          return;
        }
      } catch {
        // A corrupt local cache should never prevent the shell from opening.
      }
    }
    this.snapshot = { abilities: clone(seedAbilities), loadouts: clone(seedLoadouts), activeLoadoutId: "daily", activity: clone(seedActivity) };
    this.persist();
  }

  async getSnapshot(): Promise<PabSnapshot> {
    if (this.bridge?.getSnapshot) {
      try {
        const remote = (await this.bridge.getSnapshot()) ?? {};
        this.snapshot = {
          ...this.snapshot,
          ...remote,
          activeLoadoutId: remote.activeLoadoutId ?? this.snapshot.activeLoadoutId,
          abilities: remote.abilities ?? this.snapshot.abilities,
          loadouts: remote.loadouts ?? this.snapshot.loadouts,
          activity: remote.activity ?? this.snapshot.activity
        };
      } catch {
        // Keep the cached snapshot available while a native bridge reconnects.
      }
    }
    return clone(this.snapshot);
  }

  async installAbility(id: string): Promise<void> {
    if (this.bridge?.installAbility) await this.bridge.installAbility(id);
    const ability = this.snapshot.abilities.find((item) => item.id === id);
    if (!ability) return;
    ability.status = "installed";
    ability.installedAt = new Date().toISOString();
    ability.dataRetained = false;
    this.pushActivity({ icon: "✓", title: `${ability.name} installed`, description: `Version ${ability.version} is ready to use`, tone: "green" });
    this.persist();
  }

  async updateAbility(id: string): Promise<void> {
    if (this.bridge?.updateAbility) await this.bridge.updateAbility(id);
    const ability = this.snapshot.abilities.find((item) => item.id === id);
    if (!ability) return;
    ability.version = ability.latestVersion ?? ability.version;
    ability.latestVersion = undefined;
    ability.status = "installed";
    this.pushActivity({ icon: "↗", title: `${ability.name} updated`, description: `Now running version ${ability.version}`, tone: "blue" });
    this.persist();
  }

  async uninstallAbility(id: string, keepData = true): Promise<void> {
    if (this.bridge?.uninstallAbility) await this.bridge.uninstallAbility(id, keepData);
    const ability = this.snapshot.abilities.find((item) => item.id === id);
    if (!ability) return;
    ability.status = "available";
    ability.installedAt = undefined;
    ability.dataRetained = keepData;
    this.snapshot.loadouts.forEach((loadout) => { loadout.abilityIds = loadout.abilityIds.filter((abilityId) => abilityId !== id); });
    this.pushActivity({ icon: "–", title: `${ability.name} uninstalled`, description: keepData ? "Your ability data was kept" : "Module and data removed", tone: "amber" });
    this.persist();
  }

  async disableAbility(id: string): Promise<void> {
    if (this.bridge?.disableAbility) await this.bridge.disableAbility(id);
    const ability = this.snapshot.abilities.find((item) => item.id === id);
    if (!ability || ability.status === "available") return;
    ability.status = "disabled";
    this.pushActivity({ icon: "–", title: `${ability.name} disabled`, description: "Module and data kept on this device", tone: "amber" });
    this.persist();
  }

  async enableAbility(id: string): Promise<void> {
    if (this.bridge?.enableAbility) await this.bridge.enableAbility(id);
    const ability = this.snapshot.abilities.find((item) => item.id === id);
    if (!ability || ability.status !== "disabled") return;
    ability.status = "installed";
    this.pushActivity({ icon: "✓", title: `${ability.name} enabled`, description: "Module is back in your active Base", tone: "green" });
    this.persist();
  }

  async activateLoadout(id: string): Promise<void> {
    if (this.bridge?.activateLoadout) await this.bridge.activateLoadout(id);
    this.snapshot.loadouts.forEach((loadout) => { loadout.active = loadout.id === id; });
    this.snapshot.activeLoadoutId = id;
    const loadout = this.snapshot.loadouts.find((item) => item.id === id);
    if (loadout) this.pushActivity({ icon: "⌘", title: `${loadout.name} loadout activated`, description: `${loadout.abilityIds.length} abilities are in focus`, tone: "violet" });
    this.persist();
  }

  private pushActivity(item: Omit<ActivityItem, "id" | "time">): void {
    this.snapshot.activity.unshift({ ...item, id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()), time: "Just now" });
    this.snapshot.activity = this.snapshot.activity.slice(0, 12);
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // Storage can be unavailable in a restricted WebView/private tab. The
      // in-memory snapshot still keeps the current session usable.
    }
  }

  private readCache(): string | null {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
}
