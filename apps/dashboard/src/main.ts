import "./styles.css";
import { LocalPabAdapter } from "./adapter";
import type { AbilityManifest, Loadout, PabSnapshot } from "./adapter";

type View = "dashboard" | "store" | "abilities" | "loadouts" | "activity" | "settings";

const adapter = new LocalPabAdapter();
let snapshot: PabSnapshot;
let view: View = "dashboard";
let storeFilter = "All";
let query = "";
let selectedAbility: AbilityManifest | null = null;
let installState: { ability: AbilityManifest; step: number; mode: "install" | "update" } | null = null;
let commandPaletteOpen = false;
let toastTimer: number | undefined;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("PAB dashboard mount point is missing");

const categories = ["All", "Memory", "Execution", "Decision", "Learning", "Thinking", "Perception", "Review"];

const icon = (name: string, className = "") => `<span class="icon ${className}" aria-hidden="true">${name}</span>`;

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
  return value.replace(/[&<>'"]/g, (character) => entities[character] ?? character);
}

function accentColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : "#9a89ff";
}

function installedAbilities(): AbilityManifest[] {
  return snapshot.abilities.filter((ability) => ability.status !== "available");
}

function abilityById(id: string): AbilityManifest | undefined {
  return snapshot.abilities.find((ability) => ability.id === id);
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function friendlyInstallError(error: unknown): string {
  const structured = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const code = structured?.code ? String(structured.code) : error instanceof Error ? error.message : String(error ?? "");
  const labels: Record<string, string> = {
    DOWNLOAD_FAILED: "Download failed",
    HASH_MISMATCH: "SHA-256 verification failed",
    SIGNATURE_INVALID: "Signature invalid",
    TRUST_BLOCKED: "Source trust approval required",
    DEPENDENCY_CONFLICT: "Dependency conflict",
    DEPENDENCY_MISSING: "Dependency missing",
    DEPENDENCY_CYCLE: "Circular dependency",
    CORE_VERSION_TOO_OLD: "Core version too old",
    CORE_VERSION_UNSUPPORTED: "Core version too old",
    PLATFORM_UNSUPPORTED: "Platform unsupported",
    PERMISSION_DENIED: "Permission denied",
    MIGRATION_FAILED: "Migration failed",
    ROLLBACK_UNAVAILABLE: "Rollback unavailable"
  };
  return labels[code] ?? String((structured?.message ?? code) || "The module could not be activated.");
}

function currentLoadout(): Loadout {
  return snapshot.loadouts.find((loadout) => loadout.id === snapshot.activeLoadoutId) ?? snapshot.loadouts[0] ?? { id: "empty", name: "Daily", description: "Your default focus.", icon: "☼", abilityIds: [], active: true };
}

function renderShell(): void {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand-lockup">
          <div class="brand-mark">P</div>
          <div>
            <div class="brand-name">PERSONAL</div>
            <div class="brand-subtitle">ABILITY BASE</div>
          </div>
        </div>
        <div class="core-status"><span class="status-dot"></span><span>Core online</span><span class="status-version">v0.1.0</span></div>
        <nav class="primary-nav" aria-label="Primary navigation">
          ${navItem("dashboard", "⌂", "Dashboard")}
          ${navItem("store", "＋", "Ability Store", storeBadge())}
          ${navItem("abilities", "◈", "My Abilities", installedAbilities().length.toString())}
          ${navItem("loadouts", "⌘", "Loadouts")}
          <div class="nav-divider"></div>
          ${navItem("activity", "◷", "Activity", snapshot.activity.length.toString())}
          ${navItem("settings", "⚙", "Settings")}
        </nav>
        <div class="sidebar-bottom">
          <div class="sync-card">
            <div class="sync-heading"><span>${icon("◌")}</span><span>Local first</span><span class="sync-check">✓</span></div>
            <div class="sync-copy">Your data stays on this device.</div>
            <button class="quiet-button" data-action="backup">Backup data <span>↗</span></button>
          </div>
          <button class="profile-button" data-action="profile"><span class="avatar">LP</span><span class="profile-text"><strong>LaePe</strong><small>Personal space</small></span><span class="profile-more">•••</span></button>
        </div>
      </aside>
      <main class="main-content">
        ${renderTopbar()}
        <div class="view-container" id="view-container">${renderView()}</div>
      </main>
      <div id="modal-layer"></div>
      <div id="toast-layer" aria-live="polite"></div>
    </div>
  `;
  bindShellEvents();
}

function storeBadge(): string {
  const available = snapshot.abilities.filter((ability) => ability.status === "available").length;
  return available > 0 ? `<span class="nav-badge">${available}</span>` : "";
}

function navItem(target: View, glyph: string, label: string, trailing = ""): string {
  return `<button class="nav-item ${view === target ? "active" : ""}" data-view="${target}"><span class="nav-icon">${glyph}</span><span>${label}</span>${trailing && !/^\d+$/.test(trailing) ? trailing : trailing ? `<span class="nav-count">${trailing}</span>` : ""}</button>`;
}

function renderTopbar(): string {
  const titles: Record<View, [string, string]> = {
    dashboard: ["Good evening, LaePe", "Your abilities, ready when you are."],
    store: ["Ability Store", "Install a new capability in a few seconds."],
    abilities: ["My Abilities", "Everything installed on your Personal Ability Base."],
    loadouts: ["Loadouts", "Switch context without losing your data."],
    activity: ["Activity", "A quiet trail of what changed on your Base."],
    settings: ["Settings", "Shape the Base around the way you work."]
  };
  const [title, subtitle] = titles[view];
  return `
    <header class="topbar">
      <div class="mobile-brand"><div class="brand-mark small">P</div><span>PAB</span></div>
      <div class="page-heading"><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="topbar-actions">
        <button class="command-trigger" data-action="command" aria-label="Open command palette"><span class="search-glyph">⌕</span><span class="command-label">Search abilities, commands…</span><kbd>Ctrl</kbd><kbd>K</kbd></button>
        <button class="round-button notification-button" data-action="notifications" aria-label="Notifications">♢<span class="notification-dot"></span></button>
        <button class="round-button mobile-menu" data-action="menu" aria-label="Open menu">☰</button>
      </div>
    </header>
  `;
}

function renderView(): string {
  switch (view) {
    case "store": return renderStore();
    case "abilities": return renderAbilities();
    case "loadouts": return renderLoadouts();
    case "activity": return renderActivity();
    case "settings": return renderSettings();
    default: return renderDashboard();
  }
}

function renderDashboard(): string {
  const loadout = currentLoadout();
  const focusAbilities = loadout.abilityIds.map(abilityById).filter((ability): ability is AbilityManifest => Boolean(ability && (ability.status === "installed" || ability.status === "update")));
  const updates = snapshot.abilities.filter((ability) => ability.status === "update");
  return `
    <section class="dashboard-grid">
      <div class="hero-card glass-card">
        <div class="hero-glow glow-purple"></div><div class="hero-glow glow-blue"></div>
        <div class="hero-content">
          <div class="eyebrow"><span class="pulse-dot"></span> PERSONAL ABILITY BASE <span class="eyebrow-divider"></span> ${escapeHtml(loadout.name)} loadout</div>
          <h2>What do you need<br /><em>right now?</em></h2>
          <p>Open a capability, make a capture, or switch into a different way of working.</p>
          <div class="quick-actions">
            ${quickAction("Recall", "⌁", "pocket-cortex", "Recall something")}
            ${quickAction("Do", "✦", "skill-hud", "Run a skill")}
            ${quickAction("Decide", "◇", "decision-forge", "Frame a decision")}
            ${quickAction("Capture", "⊙", "capture-everything", "Capture thought")}
          </div>
        </div>
        <div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div><div class="hero-orbit orbit-three"></div>
        <div class="hero-signal"><span></span><span></span><span></span><small>READY</small></div>
      </div>
      <div class="loadout-card glass-card">
        <div class="card-topline"><span class="section-label">ACTIVE LOADOUT</span><button class="text-button" data-view="loadouts">Manage <span>↗</span></button></div>
        <div class="loadout-title-row"><span class="loadout-icon">${loadout.icon}</span><div><h3>${escapeHtml(loadout.name)}</h3><p>${escapeHtml(loadout.description)}</p></div></div>
        <div class="mini-ability-stack">${focusAbilities.map((ability) => miniAbility(ability)).join("")}</div>
        <button class="outline-button full-width" data-view="loadouts">Switch loadout <span>→</span></button>
      </div>
      <section class="section-block abilities-section">
        <div class="section-header"><div><span class="section-kicker">YOUR CAPABILITIES</span><h2>In focus</h2></div><button class="text-button" data-view="abilities">View all ${installedAbilities().length} <span>→</span></button></div>
        <div class="ability-grid">${focusAbilities.length ? focusAbilities.map((ability) => abilityCard(ability, true)).join("") : emptyState("No abilities in this loadout", "Add an installed ability to bring it into focus.", "Browse Store")}</div>
      </section>
      <section class="lower-grid">
        <div class="activity-card glass-card"><div class="section-header compact"><div><span class="section-kicker">RECENTLY</span><h2>Activity</h2></div><button class="text-button" data-view="activity">See all <span>→</span></button></div>${snapshot.activity.slice(0, 3).map(activityRow).join("")}</div>
        <div class="updates-card glass-card"><div class="section-header compact"><div><span class="section-kicker">KEEP GROWING</span><h2>Next for you</h2></div></div>${updates.length ? updates.slice(0, 2).map(updateRow).join("") : storeSuggestion()}</div>
      </section>
    </section>
  `;
}

function quickAction(label: string, glyph: string, abilityHint: string, description: string): string {
  return `<button class="quick-action" data-quick="${abilityHint}" title="${description}"><span class="quick-glyph">${glyph}</span><span>${label}</span><span class="quick-arrow">↗</span></button>`;
}

function miniAbility(ability: AbilityManifest): string {
  return `<button class="mini-ability" data-ability="${escapeHtml(ability.id)}"><span class="ability-symbol" style="--accent:${accentColor(ability.accent)}">${escapeHtml(ability.icon)}</span><span>${escapeHtml(ability.name)}</span><span class="mini-status"></span></button>`;
}

function renderStore(): string {
  const matching = snapshot.abilities.filter((ability) => {
    const matchesCategory = storeFilter === "All" || ability.category === storeFilter;
    const haystack = `${ability.name} ${ability.displayName} ${ability.description} ${ability.category} ${ability.tags.join(" ")}`.toLowerCase();
    return matchesCategory && (!query || haystack.includes(query.toLowerCase()));
  });
  const featured = matching.filter((ability) => ability.featured);
  const rest = matching.filter((ability) => !ability.featured);
  return `
    <section class="store-view">
      <div class="store-toolbar"><div class="store-intro"><span class="section-kicker">OFFICIAL REGISTRY · CACHED ${icon("◌", "tiny-icon")}</span><h2>Find your next ability.</h2><p>Each module adds one focused capability to your Base. Install only what earns a place.</p></div><button class="outline-button" data-action="refresh-registry">↻ Refresh registry</button></div>
      <div class="store-search-row"><label class="store-search"><span>⌕</span><input id="store-search" value="${escapeHtml(query)}" placeholder="Search the Ability Store" aria-label="Search the Ability Store" /><kbd>/</kbd></label><div class="category-tabs">${categories.map((category) => `<button class="category-tab ${storeFilter === category ? "active" : ""}" data-category="${category}">${category}</button>`).join("")}</div></div>
      ${featured.length ? `<div class="store-section"><div class="section-header compact"><div><span class="section-kicker">CURATED FOR YOU</span><h2>Featured abilities</h2></div><span class="result-count">${formatCount(featured.length, "module")}</span></div><div class="store-grid featured-grid">${featured.map((ability) => storeCard(ability, true)).join("")}</div></div>` : ""}
      <div class="store-section"><div class="section-header compact"><div><span class="section-kicker">REGISTRY</span><h2>${storeFilter === "All" ? "All abilities" : escapeHtml(storeFilter)}</h2></div><span class="result-count">${formatCount(matching.length, "module")}</span></div><div class="store-grid">${rest.length ? rest.map((ability) => storeCard(ability)).join("") : matching.length === 0 ? emptyState("No matching abilities", "Try a different search or category.", "Clear filters") : ""}</div></div>
    </section>
  `;
}

function storeCard(ability: AbilityManifest, featured = false): string {
  const safeId = escapeHtml(ability.id);
  const action = ability.status === "available" ? `<button class="install-button" data-install="${safeId}">${ability.dataRetained ? "Restore & install" : "Install"} <span>↓</span></button>` : ability.status === "update" ? `<button class="update-button" data-update="${safeId}">Update <span>↗</span></button>` : ability.status === "disabled" ? `<button class="installed-button disabled" data-enable="${safeId}">Enable <span>↗</span></button>` : `<button class="installed-button" data-ability="${safeId}"><span>✓</span> Installed</button>`;
  return `<article class="store-card ${featured ? "featured" : ""}" style="--accent:${accentColor(ability.accent)}"><button class="card-click-target" data-ability="${safeId}" aria-label="Open ${escapeHtml(ability.name)} details"></button><div class="store-card-head"><span class="ability-symbol large">${escapeHtml(ability.icon)}</span><span class="source-pill ${ability.author.includes("Official") ? "official" : "community"}">${ability.author.includes("Official") ? "Official" : "Community"}</span></div><div class="store-card-body"><div class="store-card-title"><div><h3>${escapeHtml(ability.name)}</h3><p>${escapeHtml(ability.displayName)}</p></div><span class="category-dot">${escapeHtml(ability.category)}</span></div><p class="store-description">${escapeHtml(ability.description)}</p><div class="tag-row">${ability.tags.slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div></div><div class="store-card-footer"><span class="module-size">${ability.dataRetained && ability.status === "available" ? "Previous data saved" : escapeHtml(ability.size)}</span>${action}</div></article>`;
}

function renderAbilities(): string {
  const installed = installedAbilities();
  const updates = installed.filter((ability) => ability.status === "update");
  return `<section class="abilities-view"><div class="view-hero-row"><div><span class="section-kicker">MODULE MANAGER</span><h2>Your installed abilities.</h2><p>Modules are replaceable. Your data is not tied to their code.</p></div><button class="primary-button" data-view="store">＋ Add ability</button></div>${updates.length ? `<div class="notice-banner update-banner"><span class="notice-icon">↗</span><div><strong>${updates.length} ${updates.length === 1 ? "ability has" : "abilities have"} an update</strong><span>Review release notes before updating.</span></div><button class="text-button" data-update-all>Update all <span>→</span></button></div>` : ""}<div class="installed-grid">${installed.length ? installed.map((ability) => abilityCard(ability, false, true)).join("") : emptyState("Your Base is empty", "Install your first ability from the official registry.", "Open Ability Store")}</div></section>`;
}

function abilityCard(ability: AbilityManifest, focused = false, manager = false): string {
  const safeId = escapeHtml(ability.id);
  const action = ability.status === "update" ? `<button class="small-action update" data-update="${safeId}">Update</button>` : ability.status === "disabled" ? `<button class="small-action" data-enable="${safeId}">Enable</button>` : `<button class="small-action" data-ability="${safeId}">Open</button>`;
  const statusLabel = ability.status === "update" ? "Update available" : ability.status === "disabled" ? "Disabled · data kept" : "Active";
  return `<article class="ability-card glass-card ${focused ? "focused" : ""}" style="--accent:${accentColor(ability.accent)}"><div class="ability-card-top"><span class="ability-symbol medium">${escapeHtml(ability.icon)}</span><span class="ability-status ${ability.status}">${statusLabel}</span></div><div class="ability-card-content"><h3>${escapeHtml(ability.name)}</h3><p>${escapeHtml(ability.description)}</p></div><div class="ability-card-meta"><span>${escapeHtml(ability.category)}</span><span>v${escapeHtml(ability.version)}</span>${manager ? `<span class="meta-more">•••</span>` : ""}</div><div class="ability-card-actions">${action}<button class="more-button" data-ability="${safeId}" aria-label="Open ${escapeHtml(ability.name)} details">↗</button></div></article>`;
}

function renderLoadouts(): string {
  return `<section class="loadouts-view"><div class="view-hero-row"><div><span class="section-kicker">CONTEXT SWITCHING</span><h2>Choose your mode.</h2><p>A loadout changes what is in focus; it never removes your abilities or data.</p></div><button class="outline-button" data-action="new-loadout">＋ New loadout</button></div><div class="loadout-grid">${snapshot.loadouts.map(loadoutCard).join("")}</div><div class="loadout-note"><span>⌘</span><div><strong>Loadouts are lightweight.</strong><p>They control visibility, order, and quick actions. Every module remains installed and available from the Store.</p></div></div></section>`;
}

function loadoutCard(loadout: Loadout): string {
  const abilities = loadout.abilityIds.map(abilityById).filter((ability): ability is AbilityManifest => Boolean(ability));
  const safeId = escapeHtml(loadout.id);
  return `<article class="loadout-tile ${loadout.active ? "active" : ""}"><div class="loadout-tile-head"><span class="loadout-icon large">${escapeHtml(loadout.icon)}</span>${loadout.active ? `<span class="active-pill"><span></span> Active</span>` : `<button class="activate-button" data-loadout="${safeId}">Activate</button>`}</div><h3>${escapeHtml(loadout.name)}</h3><p>${escapeHtml(loadout.description)}</p><div class="loadout-abilities">${abilities.map((ability) => `<span title="${escapeHtml(ability.name)}" style="--accent:${accentColor(ability.accent)}">${escapeHtml(ability.icon)}</span>`).join("")}<small>${formatCount(abilities.length, "ability")}</small></div><div class="loadout-tile-footer"><button class="text-button" data-action="edit-loadout" data-loadout="${safeId}">Edit <span>↗</span></button><span class="loadout-key">${loadout.id === "daily" ? "⌘ 1" : loadout.id === "developer" ? "⌘ 2" : loadout.id === "researcher" ? "⌘ 3" : "⌘ 4"}</span></div></article>`;
}

function renderActivity(): string {
  return `<section class="activity-view"><div class="view-hero-row"><div><span class="section-kicker">AUDIT TRAIL</span><h2>What changed.</h2><p>A local record of installs, updates, loadouts, and registry checks.</p></div><button class="outline-button" data-action="clear-activity">Clear history</button></div><div class="timeline">${snapshot.activity.length ? snapshot.activity.map((item, index) => `<div class="timeline-item"><div class="timeline-line ${index === snapshot.activity.length - 1 ? "last" : ""}"></div><div class="activity-bubble ${item.tone}">${item.icon}</div><div class="timeline-content"><div class="timeline-title"><strong>${escapeHtml(item.title)}</strong><time>${escapeHtml(item.time)}</time></div><p>${escapeHtml(item.description)}</p></div></div>`).join("") : emptyState("No activity yet", "Your module activity will appear here.", "Open Store")}</div></section>`;
}

function renderSettings(): string {
  return `<section class="settings-view"><div class="view-hero-row"><div><span class="section-kicker">CORE SETTINGS</span><h2>Make the Base yours.</h2><p>These controls shape the shell; abilities keep their own settings.</p></div></div><div class="settings-layout"><div class="settings-nav"><button class="settings-nav-item active">General</button><button class="settings-nav-item">Permissions</button><button class="settings-nav-item">Registry</button><button class="settings-nav-item">Storage</button><button class="settings-nav-item">Shortcuts</button></div><div class="settings-panel"><setting-group title="Appearance" description="A quiet interface that keeps your focus on the next action."><setting-row label="Theme" description="Choose how the Base looks"><select><option>Midnight</option><option>Light</option><option>System</option></select></setting-row><setting-row label="Motion" description="Use subtle transitions in the shell"><button class="toggle on" data-toggle><span></span></button></setting-row></setting-group><setting-group title="Startup" description="Decide what greets you when PAB opens."><setting-row label="Open view" description="The first page after launch"><select><option>Dashboard</option><option>Last visited</option><option>Ability Store</option></select></setting-row><setting-row label="Restore loadout" description="Return to your last active context"><button class="toggle on" data-toggle><span></span></button></setting-row></setting-group><setting-group title="Safety" description="Module code and personal data have separate lifecycles."><setting-row label="Require permission review" description="Show permissions before every install"><button class="toggle on" data-toggle><span></span></button></setting-row><setting-row label="Keep module data on uninstall" description="Recommended: preserve your ability data"><button class="toggle on" data-toggle><span></span></button></setting-row></setting-group></div></div></section>`;
}

function activityRow(item: PabSnapshot["activity"][number]): string {
  return `<div class="activity-row"><span class="activity-bubble small ${item.tone}">${item.icon}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></div><time>${escapeHtml(item.time)}</time></div>`;
}

function updateRow(ability: AbilityManifest): string {
  return `<button class="update-row" data-update="${escapeHtml(ability.id)}"><span class="ability-symbol small" style="--accent:${accentColor(ability.accent)}">${escapeHtml(ability.icon)}</span><span><strong>${escapeHtml(ability.name)}</strong><small>v${escapeHtml(ability.version)} → v${escapeHtml(ability.latestVersion ?? ability.version)}</small></span><span class="update-arrow">↗</span></button>`;
}

function storeSuggestion(): string {
  return `<div class="store-suggestion"><span class="suggestion-orbit">＋</span><div><strong>Grow your Base</strong><p>Browse the official registry for a new capability.</p></div><button class="text-button" data-view="store">Browse <span>→</span></button></div>`;
}

function emptyState(title: string, description: string, action: string): string {
  const actionAttribute = action.toLowerCase().includes("clear") ? `data-action="clear-filters"` : `data-view="store"`;
  return `<div class="empty-state"><span class="empty-icon">⌁</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><button class="outline-button" ${actionAttribute}>${escapeHtml(action)} <span>→</span></button></div>`;
}

function bindShellEvents(): void {
  app.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    const target = element.dataset.view as View | undefined;
    if (target) navigate(target);
  }));
  app.querySelectorAll<HTMLElement>("[data-ability]").forEach((element) => element.addEventListener("click", (event) => {
    event.stopPropagation();
    const ability = abilityById(element.dataset.ability ?? "");
    if (ability) openAbility(ability);
  }));
  app.querySelectorAll<HTMLElement>("[data-install]").forEach((element) => element.addEventListener("click", (event) => {
    event.stopPropagation();
    const ability = abilityById(element.dataset.install ?? "");
    if (ability) beginInstall(ability, "install");
  }));
  app.querySelectorAll<HTMLElement>("[data-update]").forEach((element) => element.addEventListener("click", (event) => {
    event.stopPropagation();
    const ability = abilityById(element.dataset.update ?? "");
    if (ability) beginInstall(ability, "update");
  }));
  app.querySelectorAll<HTMLElement>("[data-enable]").forEach((element) => element.addEventListener("click", async (event) => {
    event.stopPropagation();
    const ability = abilityById(element.dataset.enable ?? "");
    if (!ability) return;
    await adapter.enableAbility(ability.id);
    snapshot = await adapter.getSnapshot();
    rerender();
    showToast(`${ability.name} enabled`, "The module is active again; your data was preserved.", "green");
  }));
  app.querySelectorAll<HTMLElement>("[data-update-all]").forEach((element) => element.addEventListener("click", async () => {
    const updates = snapshot.abilities.filter((ability) => ability.status === "update");
    for (const ability of updates) await adapter.updateAbility(ability.id);
    snapshot = await adapter.getSnapshot();
    rerender();
    showToast("Abilities updated", `${updates.length} ${updates.length === 1 ? "module is" : "modules are"} now current.`, "green");
  }));
  app.querySelectorAll<HTMLElement>("[data-loadout]").forEach((element) => element.addEventListener("click", () => {
    if (element.dataset.loadout && element.dataset.action !== "edit-loadout") activateLoadout(element.dataset.loadout);
  }));
  app.querySelectorAll<HTMLElement>("[data-category]").forEach((element) => element.addEventListener("click", () => {
    storeFilter = element.dataset.category ?? "All";
    rerender();
  }));
  app.querySelectorAll<HTMLElement>("[data-quick]").forEach((element) => element.addEventListener("click", () => {
    const hint = element.dataset.quick ?? "";
    const ability = snapshot.abilities.find((item) => item.id.includes(hint));
    if (ability && ability.status === "available") {
      showToast(`${ability.name} is not installed yet`, "Install it from the Ability Store to use this action.", "amber");
    } else if (ability) {
      showToast(`${ability.name} ready`, `Opening ${ability.category.toLowerCase()} workspace…`, "green");
    }
  }));
  app.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => element.addEventListener("click", () => handleAction(element.dataset.action ?? "", element)));
  const storeSearch = app.querySelector<HTMLInputElement>("#store-search");
  storeSearch?.addEventListener("input", () => {
    query = storeSearch.value.trim();
    const cursor = storeSearch.selectionStart;
    rerender();
    const next = app.querySelector<HTMLInputElement>("#store-search");
    next?.focus();
    if (cursor !== null) next?.setSelectionRange(cursor, cursor);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((element) => element.addEventListener("click", () => element.classList.toggle("on")));
}

function handleAction(action: string, element?: HTMLElement): void {
  switch (action) {
    case "command": openCommandPalette(); break;
    case "menu": document.querySelector("#sidebar")?.classList.toggle("open"); break;
    case "notifications": showToast("You’re all caught up", "No new notifications from your Base.", "blue"); break;
    case "backup": showToast("Backup ready", "Your local user data is ready to export.", "green"); break;
    case "profile": showToast("Personal space", "Profile controls will arrive in Core 0.2.", "violet"); break;
    case "refresh-registry": showToast("Registry refreshed", "12 official abilities are available offline.", "blue"); break;
    case "clear-activity": snapshot.activity = []; rerender(); showToast("Activity cleared", "The module audit trail was reset.", "amber"); break;
    case "new-loadout": showToast("New loadout", "Loadout editor is ready for the next Core milestone.", "violet"); break;
    case "edit-loadout": showToast("Loadout editor", `Editing ${element?.dataset.loadout ?? "loadout"} will be available soon.`, "violet"); break;
    case "clear-filters": query = ""; storeFilter = "All"; rerender(); break;
  }
}

function navigate(next: View): void {
  view = next;
  document.querySelector("#sidebar")?.classList.remove("open");
  rerender();
}

function rerender(): void {
  renderShell();
}

function openAbility(ability: AbilityManifest): void {
  selectedAbility = ability;
  const installed = ability.status !== "available";
  const disabled = ability.status === "disabled";
  const safeId = escapeHtml(ability.id);
  const action = ability.status === "available" ? `<button class="primary-button modal-primary" data-modal-install="${safeId}">${ability.dataRetained ? "Restore & install" : "Install ability"} <span>↓</span></button>` : ability.status === "update" ? `<button class="primary-button modal-primary" data-modal-update="${safeId}">Update to ${escapeHtml(ability.latestVersion ?? "latest")} <span>↗</span></button>` : disabled ? `<button class="primary-button modal-primary" data-modal-enable="${safeId}">Enable ability <span>↗</span></button>` : `<button class="outline-button modal-primary" data-modal-open="${safeId}">Open ability <span>↗</span></button>`;
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (!modal) return;
  const management = installed ? `${disabled ? "" : `<button class="outline-button modal-secondary" data-modal-disable="${safeId}">Disable ability</button>`}<button class="danger-link" data-modal-uninstall="${safeId}">Uninstall…</button>` : `<span class="permission-hint">You’ll review permissions before install.</span>`;
  const restoreNotice = ability.status === "available" && ability.dataRetained ? `<div class="restore-notice"><span>↻</span><div><strong>Previous data found</strong><p>Install this ability to restore its saved data.</p></div></div>` : "";
  modal.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="ability-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(ability.name)}"><button class="modal-close" data-close-modal aria-label="Close">×</button><div class="modal-hero" style="--accent:${accentColor(ability.accent)}"><span class="ability-symbol huge">${escapeHtml(ability.icon)}</span><div><span class="source-pill ${ability.author.includes("Official") ? "official" : "community"}">${ability.author.includes("Official") ? "Official" : "Community"}</span><h2>${escapeHtml(ability.name)}</h2><p>${escapeHtml(ability.displayName)} · ${escapeHtml(ability.category)}</p></div></div><div class="modal-body"><p class="modal-description">${escapeHtml(ability.longDescription)}</p>${restoreNotice}<div class="manifest-summary"><div><span>VERSION</span><strong>${escapeHtml(ability.version)}${ability.latestVersion ? ` <i>→ ${escapeHtml(ability.latestVersion)}</i>` : ""}</strong></div><div><span>SIZE</span><strong>${escapeHtml(ability.size)}</strong></div><div><span>PLATFORMS</span><strong>${ability.platforms.map((platform) => platform === "windows" ? "Windows" : "Android").join(" · ")}</strong></div></div><div class="modal-section"><span class="section-kicker">WHAT IT CONTRIBUTES</span><div class="contribution-row"><span>${icon("▦")} ${formatCount(ability.contributes.pages, "page")}</span><span>${icon("⌘")} ${formatCount(ability.contributes.commands, "command")}</span><span>${icon("◆")} ${formatCount(ability.contributes.cards, "card")}</span><span>${icon("↗")} ${formatCount(ability.contributes.workflows, "workflow")}</span></div></div><div class="modal-section"><span class="section-kicker">PERMISSIONS</span><div class="permission-row">${ability.permissions.map((permission) => `<span>${escapeHtml(permission)}</span>`).join("")}</div></div></div><div class="modal-footer">${management}<div class="modal-actions">${action}</div></div></section></div>`;
  modal.querySelectorAll<HTMLElement>("[data-close-modal]").forEach((element) => element.addEventListener("click", (event) => { if (event.target === element) closeModal(); else if (element.classList.contains("modal-close")) closeModal(); }));
  modal.querySelector<HTMLElement>(".modal-close")?.addEventListener("click", closeModal);
  modal.querySelector<HTMLElement>("[data-modal-install]")?.addEventListener("click", () => { closeModal(); beginInstall(ability, "install"); });
  modal.querySelector<HTMLElement>("[data-modal-update]")?.addEventListener("click", () => { closeModal(); beginInstall(ability, "update"); });
  modal.querySelector<HTMLElement>("[data-modal-open]")?.addEventListener("click", () => { closeModal(); showToast(`${ability.name} opened`, "Its workspace is connected to the Ability Runtime.", "green"); });
  modal.querySelector<HTMLElement>("[data-modal-disable]")?.addEventListener("click", async () => { closeModal(); await adapter.disableAbility(ability.id); snapshot = await adapter.getSnapshot(); rerender(); showToast(`${ability.name} disabled`, "The module and its data remain installed.", "amber"); });
  modal.querySelector<HTMLElement>("[data-modal-enable]")?.addEventListener("click", async () => { closeModal(); await adapter.enableAbility(ability.id); snapshot = await adapter.getSnapshot(); rerender(); showToast(`${ability.name} enabled`, "Your module and data are active again.", "green"); });
  modal.querySelector<HTMLElement>("[data-modal-uninstall]")?.addEventListener("click", () => { closeModal(); confirmUninstall(ability); });
}

function closeModal(): void {
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (modal) modal.innerHTML = "";
  selectedAbility = null;
}

function confirmUninstall(ability: AbilityManifest): void {
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (!modal) return;
  modal.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="confirm-modal" role="dialog" aria-modal="true"><span class="confirm-icon">!</span><h2>Uninstall ${escapeHtml(ability.name)}?</h2><p>This removes the module code from your Base. Your ability data is separate and can stay safely on this device for a future restore.</p><label class="keep-data"><input type="checkbox" checked id="keep-data" /><span><strong>Keep my data</strong><small>Recommended · restore on reinstall</small></span></label><div class="confirm-actions"><button class="outline-button" data-close-modal>Cancel</button><button class="danger-button" data-confirm-uninstall>Uninstall module</button></div></section></div>`;
  modal.querySelectorAll<HTMLElement>("[data-close-modal]").forEach((element) => element.addEventListener("click", (event) => { if (event.target === element || element.classList.contains("outline-button")) closeModal(); }));
  modal.querySelector<HTMLElement>("[data-confirm-uninstall]")?.addEventListener("click", async () => { const keep = modal.querySelector<HTMLInputElement>("#keep-data")?.checked ?? true; closeModal(); await adapter.uninstallAbility(ability.id, keep); snapshot = await adapter.getSnapshot(); rerender(); showToast(`${ability.name} uninstalled`, keep ? "Your data was kept for a future restore." : "Module and data were removed.", "amber"); });
}

const installSteps = ["Discover registry entry", "Resolve dependencies", "Download package", "Verify SHA-256", "Verify signature", "Inspect permissions", "Install and register", "Activate ability"];

function beginInstall(ability: AbilityManifest, mode: "install" | "update"): void {
  installState = { ability, mode, step: 0 };
  renderInstallModal();
  window.setTimeout(advanceInstall, 480);
}

function renderInstallModal(): void {
  if (!installState) return;
  const { ability, mode, step } = installState;
  const completed = Math.max(0, step);
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (!modal) return;
  modal.innerHTML = `<div class="modal-backdrop install-backdrop"><section class="install-modal" role="dialog" aria-modal="true"><div class="install-head"><span class="ability-symbol medium" style="--accent:${accentColor(ability.accent)}">${escapeHtml(ability.icon)}</span><div><span class="section-kicker">${mode === "install" ? "INSTALLING ABILITY" : "UPDATING ABILITY"}</span><h2>${escapeHtml(ability.name)}</h2></div><span class="install-percent">${Math.min(100, Math.round((completed / installSteps.length) * 100))}%</span></div><div class="progress-track"><span style="width:${Math.min(100, (completed / installSteps.length) * 100)}%"></span></div><div class="install-steps">${installSteps.map((label, index) => `<div class="install-step ${index < completed ? "done" : index === completed ? "current" : ""}"><span class="step-indicator">${index < completed ? "✓" : index === completed ? "…" : "·"}</span><span>${label}</span>${index < completed ? `<small>${index === 2 ? escapeHtml(ability.size) : index === 4 ? "Signature valid" : "OK"}</small>` : index === completed ? `<small>working</small>` : ""}</div>`).join("")}</div><div class="install-permissions"><span>Permissions requested</span><div>${ability.permissions.map((permission) => `<code>${escapeHtml(permission)}</code>`).join("")}</div></div><div class="install-footer"><span>Core keeps your data separate from module code.</span>${completed >= installSteps.length ? `<button class="primary-button" data-install-done>Open ${escapeHtml(ability.name)} <span>↗</span></button>` : `<button class="quiet-button" data-install-cancel>Cancel</button>`}</div></section></div>`;
  modal.querySelector<HTMLElement>("[data-install-cancel]")?.addEventListener("click", () => { installState = null; closeModal(); showToast("Install cancelled", "No files were changed.", "amber"); });
  modal.querySelector<HTMLElement>("[data-install-done]")?.addEventListener("click", () => { installState = null; closeModal(); showToast(`${ability.name} is ready`, "The module was registered and activated.", "green"); });
}

async function advanceInstall(): Promise<void> {
  if (!installState) return;
  if (installState.step < installSteps.length) {
    installState.step += 1;
    renderInstallModal();
    window.setTimeout(advanceInstall, installState.step === installSteps.length ? 420 : 640);
    return;
  }
  const { ability, mode } = installState;
  try {
    if (mode === "install") await adapter.installAbility(ability.id); else await adapter.updateAbility(ability.id);
    snapshot = await adapter.getSnapshot();
    renderInstallModal();
  } catch (error) {
    const reason = friendlyInstallError(error);
    installState = null;
    closeModal();
    rerender();
    showToast(mode === "install" ? "Install failed" : "Update failed", reason, "amber");
  }
}

function openCommandPalette(): void {
  commandPaletteOpen = true;
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (!modal) return;
  modal.innerHTML = `<div class="palette-backdrop" data-close-palette><section class="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><div class="palette-input-row"><span>⌕</span><input id="palette-input" placeholder="Search abilities and commands" autofocus /><kbd>ESC</kbd></div><div class="palette-results" id="palette-results">${commandResults("")}</div><div class="palette-footer"><span>↑↓ Navigate</span><span>↵ Open</span><span>ESC Close</span></div></section></div>`;
  const input = modal.querySelector<HTMLInputElement>("#palette-input");
  let paletteIndex = 0;
  input?.focus();
  input?.addEventListener("input", () => { paletteIndex = 0; const results = modal.querySelector<HTMLDivElement>("#palette-results"); if (results) results.innerHTML = commandResults(input.value); bindPaletteResults(modal); });
  input?.addEventListener("keydown", (event) => {
    const results = [...modal.querySelectorAll<HTMLElement>("[data-palette-action]")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) {
        paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        results.forEach((result, index) => result.classList.toggle("selected", index === paletteIndex));
      }
    }
    if (event.key === "Enter" && results[paletteIndex]) {
      event.preventDefault();
      results[paletteIndex].click();
    }
  });
  modal.querySelector<HTMLElement>("[data-close-palette]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) closePalette(); });
  bindPaletteResults(modal);
}

function commandResults(value: string): string {
  const lower = value.trim().toLowerCase();
  const commands = [
    { icon: "⌂", title: "Go to Dashboard", subtitle: "View your active abilities", action: "dashboard" },
    { icon: "＋", title: "Add an Ability", subtitle: "Open the Ability Store", action: "store" },
    { icon: "⌘", title: "Switch Loadout", subtitle: "Change what is in focus", action: "loadouts" },
    { icon: "⊙", title: "Capture a thought", subtitle: "Open quick capture", action: "capture" },
    ...snapshot.abilities.map((ability) => ({ icon: ability.icon, title: `${ability.status === "available" ? "Install" : "Open"} ${ability.name}`, subtitle: `${ability.category} · v${ability.version}`, action: ability.id }))
  ].filter((command) => `${command.title} ${command.subtitle}`.toLowerCase().includes(lower));
  return commands.length ? commands.slice(0, 8).map((command, index) => `<button class="palette-result ${index === 0 ? "selected" : ""}" data-palette-action="${escapeHtml(command.action)}"><span class="palette-result-icon">${command.icon}</span><span><strong>${escapeHtml(command.title)}</strong><small>${escapeHtml(command.subtitle)}</small></span><kbd>${index < 4 ? `⌘ ${index + 1}` : "↵"}</kbd></button>`).join("") : `<div class="palette-empty">No commands match “${escapeHtml(value)}”</div>`;
}

function bindPaletteResults(modal: HTMLDivElement): void {
  modal.querySelectorAll<HTMLElement>("[data-palette-action]").forEach((element) => element.addEventListener("click", () => {
    const action = element.dataset.paletteAction ?? "";
    closePalette();
    if (["dashboard", "store", "loadouts"].includes(action)) navigate(action as View);
    else if (action === "capture") showToast("Quick capture", "Capture workspace connected to the Ability Bus.", "green");
    else {
      const ability = abilityById(action);
      if (ability) openAbility(ability);
    }
  }));
}

function closePalette(): void {
  commandPaletteOpen = false;
  const modal = document.querySelector<HTMLDivElement>("#modal-layer");
  if (modal) modal.innerHTML = "";
}

function showToast(title: string, message: string, tone: "green" | "blue" | "violet" | "amber"): void {
  const layer = document.querySelector<HTMLDivElement>("#toast-layer");
  if (!layer) return;
  window.clearTimeout(toastTimer);
  layer.innerHTML = `<div class="toast ${tone}"><span class="toast-icon">${tone === "green" ? "✓" : tone === "amber" ? "!" : tone === "violet" ? "⌘" : "i"}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div><button data-dismiss-toast>×</button></div>`;
  layer.querySelector<HTMLElement>("[data-dismiss-toast]")?.addEventListener("click", () => { layer.innerHTML = ""; });
  toastTimer = window.setTimeout(() => { layer.innerHTML = ""; }, 4800);
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); if (commandPaletteOpen) closePalette(); else openCommandPalette(); }
  if (event.key === "Escape") { if (commandPaletteOpen) closePalette(); else closeModal(); }
  if (view === "store" && event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); app.querySelector<HTMLInputElement>("#store-search")?.focus(); }
});

async function bootstrap(): Promise<void> {
  snapshot = await adapter.getSnapshot();
  renderShell();
}

void bootstrap();
