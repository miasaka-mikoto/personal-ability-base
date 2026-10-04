#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PABCore } from "../packages/core/src/index.js";

// Keep the source tree runnable before npm has linked workspaces. A normal
// `npm install` creates the same link automatically from the workspace map.
const root = dirname(fileURLToPath(import.meta.url));
const workspaceLink = join(root, "..", "node_modules", "@pab", "ability-sdk");
try { await mkdir(dirname(workspaceLink), { recursive: true }); await symlink("../../packages/ability-sdk", workspaceLink, "dir"); } catch { /* already linked */ }

const core = new PABCore({
  platform: "windows",
  promptPermission: () => "allow",
  logger: { log() {}, info() {}, warn() {}, error() {} },
});
await core.start();

const abilityRoot = join(root, "..", "abilities");
const load = async (name) => {
  const manifest = JSON.parse(await readFile(join(abilityRoot, name, "manifest.json"), "utf8"));
  const entry = pathToFileURL(join(abilityRoot, name, manifest.entry)).href;
  return { manifest, packageRef: entry, loader: async () => import(entry) };
};

await core.installAbility(await load("pocket-cortex"));
await core.installAbility(await load("skill-hud"));
await core.installAbility(await load("decision-forge"));
await core.installAbility(await load("capture-everything"));
assert.ok(core.commands.get("pocket-cortex.capture"));
assert.ok(core.commands.get("skill-hud.start"));
assert.ok(core.commands.get("decision-forge.create"));
assert.ok(core.commands.get("capture-everything.capture"));
await core.commands.execute("pocket-cortex.capture", { text: "PAB smoke memory", tags: ["smoke"] });
const recalled = await core.commands.execute("pocket-cortex.recall", { text: "smoke" });
assert.equal(recalled.length, 1);
const started = await core.commands.execute("skill-hud.start", { skillId: "smoke", steps: ["one"] });
assert.equal(started.status, "running");
const decision = await core.commands.execute("decision-forge.create", { question: "Ship the smoke test?", choice: "Yes", options: ["Yes", "No"] });
assert.equal(decision.status, "open");
const reviewed = await core.commands.execute("decision-forge.review", { id: decision.id, outcome: "Passed" });
assert.equal(reviewed.status, "reviewed");
const captured = await core.commands.execute("capture-everything.quick-capture", { text: "PAB capture ability smoke", tags: ["smoke"], channel: "quick" });
assert.equal(captured.memoryWritten, true);
assert.equal((await core.commands.execute("capture-everything.list", { text: "capture ability smoke" })).length, 1);
assert.equal((await core.memory.query({ text: "PAB capture ability smoke", source: "com.pab.capture-everything" })).length, 1);
await core.eventBus.publish("capture.created", { id: "android-share-smoke", text: "PAB Android share smoke", channel: "share", tags: ["android", "smoke"] }, { source: "android.share" });
assert.equal((await core.commands.execute("capture-everything.list", { text: "Android share smoke" })).length, 1);
assert.equal((await core.memory.query({ text: "PAB Android share smoke" })).length, 1, "host capture must not be duplicated by Pocket Cortex");
await core.disableAbility("com.pab.skill-hud");
assert.equal((await core.moduleStore.get("com.pab.skill-hud")).enabled, false);
await core.uninstallAbility("com.pab.skill-hud");
assert.equal(await core.moduleStore.has("com.pab.skill-hud"), false);
assert.equal((await core.memory.query({ text: "PAB smoke" })).length, 1);
await core.stop();
console.log("PAB core + official abilities smoke: PASS");
