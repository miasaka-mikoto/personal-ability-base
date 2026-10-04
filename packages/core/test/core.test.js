import test from "node:test";
import assert from "node:assert/strict";
import {
  PABCore, MemoryStorage, EventBus, CommandBus, PermissionManager,
  validateManifest, satisfies, DependencyResolver, PabError, ErrorCode,
} from "../src/index.js";

const baseManifest = (version = "1.0.0") => ({
  schemaVersion: 1,
  id: "com.pab.test.ability",
  name: "Test Ability",
  displayName: "测试能力",
  version,
  description: "test",
  minCoreVersion: "0.1.0",
  platforms: ["windows", "android"],
  permissions: ["memory.write"],
  dependencies: {},
  optionalDependencies: {},
  contributes: { pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [] },
  entry: "dist/index.js",
});

test("manifest validation and semver ranges", () => {
  const manifest = validateManifest(baseManifest());
  assert.equal(manifest.version, "1.0.0");
  assert.equal(satisfies("1.2.0", "^1.0.0"), true);
  assert.equal(satisfies("2.0.0", "^1.0.0"), false);
  assert.throws(() => validateManifest({ ...baseManifest(), id: "Bad ID" }), (error) => error.code === ErrorCode.INVALID_MANIFEST);
});

test("event and command bus route namespaced actions", async () => {
  const events = new EventBus({ idFactory: () => "evt_test" });
  const seen = [];
  events.subscribe("capture.*", (event) => seen.push(event.type));
  await events.publish("capture.created", { id: "m1" });
  assert.deepEqual(seen, ["capture.created"]);
  const commands = new CommandBus({ eventBus: events });
  commands.register({ id: "test.echo", handler: (value) => value });
  assert.equal(await commands.execute("test.echo", "ok"), "ok");
});

test("request bus returns responses and emits correlation events", async () => {
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage() });
  await core.start();
  const seen = [];
  core.eventBus.subscribe("request.*", (event) => seen.push(event.type));
  core.requests.register({ id: "test.echo", handler: (payload) => ({ payload }) });
  assert.deepEqual(await core.requests.request("test.echo", "ok", { source: "com.pab.test" }), { payload: "ok" });
  assert.deepEqual(seen, ["request.started", "request.completed"]);
  await core.stop();
});

test("dependency resolver detects cycles and chooses highest compatible version", () => {
  const one = { ...baseManifest("1.0.0"), id: "com.pab.dep" };
  const two = { ...baseManifest("2.0.0"), id: "com.pab.dep" };
  const resolver = new DependencyResolver({ "com.pab.dep": [one, two] });
  assert.equal(resolver.resolve({ "com.pab.dep": "^1.0.0" }).order[0].manifest.version, "1.0.0");
  assert.equal(resolver.resolve({ "com.pab.dep": "*" }, { installed: { "com.pab.dep": "1.0.0" } }).order[0].manifest.version, "1.0.0");
  const cycleA = { ...baseManifest("1.0.0"), id: "com.pab.a", dependencies: { "com.pab.b": "*" } };
  const cycleB = { ...baseManifest("1.0.0"), id: "com.pab.b", dependencies: { "com.pab.a": "*" } };
  assert.throws(() => new DependencyResolver([cycleA, cycleB]).resolve({ "com.pab.a": "*" }), (error) => error.code === ErrorCode.DEPENDENCY_CYCLE);
  const conflictRoot = { ...baseManifest("1.0.0"), id: "com.pab.conflict-root", dependencies: { "com.pab.conflict-dep": "*" }, conflicts: { "com.pab.conflict-dep": "*" } };
  const conflictDep = { ...baseManifest("1.0.0"), id: "com.pab.conflict-dep" };
  assert.throws(() => new DependencyResolver([conflictRoot, conflictDep]).resolve({ "com.pab.conflict-root": "*" }), (error) => error.code === ErrorCode.DEPENDENCY_CONFLICT);
  const registryOnly = { id: "com.pab.registry", name: "Registry Ability", version: "1.0.0", repository: "org/repo", packageUrl: "https://example.test/a.zip", platforms: ["windows"], minCoreVersion: "0.1.0" };
  assert.equal(new DependencyResolver([registryOnly]).resolve({ "com.pab.registry": "*" }).order[0].manifest.entry, "dist/index.js");
});

test("core installs, activates, updates, rolls back, and preserves user data", async () => {
  const storage = new MemoryStorage();
  const core = new PABCore({ platform: "windows", storage, promptPermission: async () => "allow", loadAbility: async ({ manifest }) => ({
    activate: async (context) => {
      context.registerPage({ id: `${manifest.id}.page`, title: "Test" });
      context.registerCommand({ id: `${manifest.id}.hello`, handler: () => "hello" });
      await context.memory.write({ content: `installed ${manifest.version}`, tags: ["test"] });
    },
    deactivate: async () => {},
  }) });
  await core.start();
  const first = await core.installAbility({ manifest: baseManifest("1.0.0"), packageRef: "memory://1" });
  assert.equal(first.record.activeVersion, "1.0.0");
  assert.equal(await core.commands.execute("com.pab.test.ability.hello"), "hello");
  assert.equal((await core.memory.query({ text: "installed" })).length, 1);
  await core.updateAbility({ manifest: baseManifest("1.1.0"), packageRef: "memory://2" });
  assert.equal((await core.moduleStore.get("com.pab.test.ability")).activeVersion, "1.1.0");
  await core.rollbackAbility("com.pab.test.ability", "1.0.0");
  assert.equal((await core.moduleStore.get("com.pab.test.ability")).activeVersion, "1.0.0");
  await core.disableAbility("com.pab.test.ability");
  assert.equal((await core.moduleStore.get("com.pab.test.ability")).enabled, false);
  await core.enableAbility("com.pab.test.ability");
  await core.uninstallAbility("com.pab.test.ability");
  assert.equal(await core.moduleStore.has("com.pab.test.ability"), false);
  assert.ok((await core.memory.query({ text: "installed" })).length >= 1, "uninstall must preserve user data");
  await core.stop();
});

test("permission manager supports ask/deny and revocation", async () => {
  const events = new EventBus();
  const manager = new PermissionManager({ storage: new MemoryStorage(), eventBus: events, prompt: async () => "deny" });
  const result = await manager.request("com.pab.test", ["microphone"]);
  assert.equal(result.microphone, "deny");
  await assert.rejects(() => manager.assert("com.pab.test", "microphone"), (error) => error.code === ErrorCode.PERMISSION_DENIED);
  await manager.set("com.pab.test", "microphone", "allow");
  assert.equal(await manager.assert("com.pab.test", "microphone"), true);
  await manager.revoke("com.pab.test", "microphone");
  assert.equal(await manager.get("com.pab.test", "microphone"), "ask");
});

test("backup and restore keep module metadata separate from user data", async () => {
  const storage = new MemoryStorage();
  const core = new PABCore({ platform: "android", storage, promptPermission: async () => "allow" });
  await core.start();
  await core.memory.write({ text: "portable memory", tags: ["backup"] });
  await core.settingsStorage.set("theme", "dark");
  await core.installAbility({ manifest: { ...baseManifest("1.0.0"), id: "com.pab.backup" }, packageRef: "memory://backup" }, { activate: false });
  await core.setAbilityUpdatePolicy("com.pab.backup", { mode: "pinned", version: "1.0.0" });
  const snapshot = await core.backup();
  const restored = new PABCore({ platform: "android", storage: new MemoryStorage(), promptPermission: async () => "allow" });
  await restored.start();
  await restored.restore(snapshot);
  assert.equal((await restored.memory.query({ text: "portable" }))[0].text, "portable memory");
  assert.equal(await restored.settingsStorage.get("theme"), "dark");
  assert.deepEqual(await restored.getAbilityUpdatePolicy("com.pab.backup"), { mode: "pinned", version: "1.0.0" });
  await core.stop();
  await restored.stop();
});

test("failed migration blocks update before module state changes", async () => {
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage(), promptPermission: async () => "allow", migrate: async () => { throw new Error("schema mismatch"); }, loadAbility: async () => ({ activate: async () => {} }) });
  await core.start();
  await core.installAbility({ manifest: baseManifest("1.0.0"), packageRef: "memory://old" });
  const next = { ...baseManifest("1.1.0"), migrations: [{ from: "1.0.0", to: "1.1.0" }] };
  await assert.rejects(() => core.updateAbility({ manifest: next, packageRef: "memory://new" }), (error) => error.code === ErrorCode.MIGRATION_FAILED);
  assert.equal((await core.moduleStore.get("com.pab.test.ability")).activeVersion, "1.0.0");
  await core.stop();
});

test("enabled modules rehydrate after Core restart when a loader is available", async () => {
  const storage = new MemoryStorage();
  let activations = 0;
  const manifest = baseManifest("1.0.0");
  const create = () => new PABCore({ platform: "windows", storage, promptPermission: async () => "allow", loadAbility: async () => ({ activate: async () => { activations += 1; } }) });
  const first = create();
  await first.start();
  await first.installAbility({ manifest, packageRef: "memory://rehydrate" });
  await first.stop();
  const second = create();
  await second.start();
  assert.equal(activations, 2);
  await second.stop();
});

test("loadouts switch focus without removing abilities", async () => {
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage() });
  await core.start();
  await core.loadouts.create({ id: "daily", name: "Daily", abilityIds: ["com.pab.a"] });
  await core.loadouts.create({ id: "research", name: "Research", abilityIds: ["com.pab.b"] });
  await core.activateLoadout("research");
  assert.equal((await core.loadouts.active()).id, "research");
  assert.equal((await core.loadouts.get("daily")).abilityIds[0], "com.pab.a");
  await core.stop();
});

test("repair/reset and per-ability data export/import keep code and data separate", async () => {
  const storage = new MemoryStorage();
  const manifest = baseManifest("1.0.0");
  const core = new PABCore({ platform: "windows", storage, promptPermission: async () => "allow", loadAbility: async () => ({
    activate: async (context) => {
      await context.storage.set("draft", { value: 42 });
      await context.memory.write({ text: "ability-owned" });
    },
  }) });
  await core.start();
  await core.installAbility({ manifest, packageRef: "memory://data" });
  const snapshot = await core.exportAbilityData(manifest.id);
  assert.equal(snapshot.storage.draft.value, 42);
  assert.equal(snapshot.memories.length, 1);
  await core.repairAbility(manifest.id);
  await core.resetAbility(manifest.id, { removeData: true, activate: false });
  assert.equal((await core.exportAbilityData(manifest.id)).memories.length, 0);
  await core.importAbilityData(manifest.id, snapshot, { replace: true });
  const restored = await core.exportAbilityData(manifest.id);
  assert.equal(restored.storage.draft.value, 42);
  assert.equal(restored.memories.length, 1);
  await core.stop();
});

test("registry refresh caches entries and remains readable offline", async () => {
  const document = { schemaVersion: 1, abilities: [{ ...baseManifest("1.0.0"), id: "com.pab.registry", name: "Registry Ability", platforms: ["windows"] }] };
  let online = true;
  const registry = {
    async refresh() { if (!online) throw new Error("offline"); return { document, meta: { stale: false } }; },
    async load() { return null; },
  };
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage(), registry });
  await core.start();
  await core.refreshRegistry({});
  online = false;
  const cached = await core.refreshRegistry({});
  assert.equal(cached.meta.stale, true);
  assert.equal((await core.getRegistry()).document.abilities[0].id, "com.pab.registry");
  const dashboard = await core.getDashboardSnapshot();
  assert.equal(dashboard.abilities[0].id, "com.pab.registry");
  await core.stop();
});

test("module manager preserves a separately refreshed dependency catalog", async () => {
  const dependency = { ...baseManifest("1.0.0"), id: "com.pab.dep" };
  const rootManifest = { ...baseManifest("1.0.0"), id: "com.pab.root", dependencies: { "com.pab.dep": "^1.0.0" } };
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage(), promptPermission: async () => "allow", downloadPackage: async (id) => ({ manifest: dependency, packageRef: `memory://${id}` }), loadAbility: async () => ({ activate: async () => {} }) });
  await core.start();
  core.modules.setCatalog([dependency]);
  await core.installAbility({ manifest: rootManifest, packageRef: "memory://root" });
  assert.equal(await core.moduleStore.has("com.pab.dep"), true);
  assert.equal(await core.moduleStore.has("com.pab.root"), true);
  await core.stop();
});

test("UI-compatible boolean keepData argument controls uninstall data removal", async () => {
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage(), promptPermission: async () => "allow", loadAbility: async () => ({ activate: async (context) => context.storage.set("draft", true) }) });
  await core.start();
  await core.installAbility({ manifest: baseManifest(), packageRef: "memory://ui" });
  await core.uninstallAbility("com.pab.test.ability", false);
  assert.equal((await core.exportAbilityData("com.pab.test.ability")).storage.draft, undefined);
  await core.stop();
});

test("update policies support automatic, ignore, and pinned modes", async () => {
  const storage = new MemoryStorage();
  const core = new PABCore({ platform: "windows", storage, promptPermission: async () => "allow", loadAbility: async () => ({ activate: async () => {} }) });
  await core.start();
  await core.installAbility({ manifest: baseManifest("1.0.0"), packageRef: "memory://policy-1" });
  await core.setAbilityUpdatePolicy("com.pab.test.ability", { mode: "automatic" });
  const automatic = await core.updateAbility({ manifest: baseManifest("1.1.0"), packageRef: "memory://policy-2" }, { trigger: "automatic" });
  assert.equal(automatic.record.activeVersion, "1.1.0");
  await core.setAbilityUpdatePolicy("com.pab.test.ability", { mode: "pinned", version: "1.1.0" });
  const pinned = await core.updateAbility({ manifest: baseManifest("1.2.0"), packageRef: "memory://policy-3" });
  assert.equal(pinned.skipped, true);
  await core.setAbilityUpdatePolicy("com.pab.test.ability", { mode: "ignore", version: "1.3.0" });
  const ignored = await core.updateAbility({ manifest: baseManifest("1.3.0"), packageRef: "memory://policy-4" });
  assert.equal(ignored.reason, "ignored:1.3.0");
  await core.stop();

  // Policies live in Core metadata, independently from module code/data, and
  // survive a process restart through the host storage adapter.
  const restarted = new PABCore({ platform: "windows", storage, promptPermission: async () => "allow" });
  await restarted.start();
  assert.deepEqual(await restarted.getAbilityUpdatePolicy("com.pab.test.ability"), { mode: "ignore", version: "1.3.0" });
  await restarted.stop();
});

test("dashboard hides ignored releases and honors pinned updates", async () => {
  const storage = new MemoryStorage();
  const v1 = baseManifest("1.0.0");
  const v2 = baseManifest("1.1.0");
  const registry = {
    async refresh() { return { document: { schemaVersion: 1, abilities: [v1, v2] }, meta: { stale: false } }; },
    async load() { return null; },
  };
  const core = new PABCore({ platform: "windows", storage, registry, promptPermission: async () => "allow", loadAbility: async () => ({ activate: async () => {} }) });
  await core.start();
  await core.refreshRegistry({});
  await core.installAbility({ manifest: v1, packageRef: "memory://dashboard-policy" });
  let ability = (await core.getDashboardSnapshot()).abilities.find((item) => item.id === v1.id);
  assert.equal(ability.status, "update");
  await core.setAbilityUpdatePolicy(v1.id, { mode: "ignore", version: "1.1.0" });
  ability = (await core.getDashboardSnapshot()).abilities.find((item) => item.id === v1.id);
  assert.equal(ability.status, "installed");
  assert.equal(ability.latestVersion, undefined);
  await core.setAbilityUpdatePolicy(v1.id, { mode: "pinned", version: "1.1.0" });
  ability = (await core.getDashboardSnapshot()).abilities.find((item) => item.id === v1.id);
  assert.equal(ability.status, "update");
  await core.stop();
});

test("uninstall defaults to keeping Ability data and can explicitly remove it", async () => {
  const core = new PABCore({ platform: "windows", storage: new MemoryStorage(), promptPermission: async () => "allow", loadAbility: async () => ({
    activate: async (context) => { await context.memory.write({ text: "retained" }); },
  }) });
  await core.start();
  const manifest = baseManifest("1.0.0");
  await core.installAbility({ manifest, packageRef: "memory://retain" });
  await core.loadouts.create({ id: "daily", abilityIds: [manifest.id] });
  const kept = await core.uninstallAbility(manifest.id);
  assert.equal(kept.dataPreserved, true);
  assert.equal((await core.memory.query({ source: manifest.id })).length, 1);
  assert.equal((await core.loadouts.get("daily")).abilityIds.includes(manifest.id), false);

  await core.installAbility({ manifest, packageRef: "memory://restore" });
  const removed = await core.uninstallAbility(manifest.id, { keepData: false });
  assert.equal(removed.dataRemoved, true);
  assert.equal((await core.memory.query({ source: manifest.id })).length, 0);
  await core.stop();
});

test("dashboard snapshot exposes retained data after module uninstall", async () => {
  const storage = new MemoryStorage();
  const manifest = baseManifest("1.0.0");
  const core = new PABCore({
    storage,
    platform: "windows",
    promptPermission: async () => "allow",
    loadAbility: async () => ({ activate: async () => {} }),
    registry: { async load() { return { document: { abilities: [manifest] } }; } },
  });
  await core.start();
  await core.installAbility({ manifest, packageRef: "memory://snapshot" });
  await core.uninstallAbility(manifest.id);

  const retained = (await core.getDashboardSnapshot()).abilities.find((ability) => ability.id === manifest.id);
  assert.equal(retained.status, "available");
  assert.equal(retained.dataRetained, true);

  await core.installAbility({ manifest, packageRef: "memory://snapshot-restore" });
  const restored = (await core.getDashboardSnapshot()).abilities.find((ability) => ability.id === manifest.id);
  assert.equal(restored.status, "installed");
  assert.equal(restored.dataRetained, false);

  await core.uninstallAbility(manifest.id, { keepData: false });
  const removed = (await core.getDashboardSnapshot()).abilities.find((ability) => ability.id === manifest.id);
  assert.equal(removed.status, "available");
  assert.equal(removed.dataRetained, false);
  await core.stop();
});
