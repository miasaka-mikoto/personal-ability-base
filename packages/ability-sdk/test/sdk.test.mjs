import test from "node:test";
import assert from "node:assert/strict";
import { createAbilityContext, registerAbility, validateManifest } from "../index.js";
import { createTestRuntime } from "../testing.js";

const manifest = {
  schemaVersion: 1,
  id: "com.pab.test",
  name: "Test Ability",
  displayName: "测试能力",
  version: "0.1.0",
  description: "test",
  author: "PAB",
  minCoreVersion: "0.1.0",
  platforms: ["windows", "android"],
  permissions: ["storage.private", "memory.read", "memory.write"],
  dependencies: {},
  optionalDependencies: {},
  contributes: { pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [] },
  entry: "dist/index.js"
};

test("manifest validation rejects malformed IDs and accepts the fixture", () => {
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(validateManifest({ ...manifest, id: "Bad ID" }).valid, false);
});

test("context namespaces storage and enforces permissions", () => {
  const runtime = createTestRuntime();
  const api = createAbilityContext(runtime, manifest, { grantedPermissions: ["storage.private"] });
  api.storage.set("answer", 42);
  assert.equal(api.storage.get("answer"), 42);
  assert.throws(() => api.memory.query({}), /Permission denied: memory.read/);
});

test("registerAbility is idempotent and disposes event subscriptions", async () => {
  const runtime = createTestRuntime();
  let events = 0;
  const handle = await registerAbility(runtime, manifest, {
    activate(api) { api.subscribeEvent("test.event", () => { events += 1; }); },
    deactivate() {}
  }, { grantedPermissions: manifest.permissions });
  await handle.activate();
  await handle.activate();
  runtime.publishEvent("test.event", {});
  assert.equal(events, 1);
  await handle.deactivate();
  runtime.publishEvent("test.event", {});
  assert.equal(events, 1);
});

test("test runtime accepts command contributions", async () => {
  const runtime = createTestRuntime();
  const handle = await registerAbility(runtime, manifest, {
    activate(api) { api.registerCommand({ id: "test.echo", execute: (value) => value }); }
  }, { grantedPermissions: manifest.permissions });
  await handle.activate();
  assert.equal(await runtime.executeCommand("test.echo", "ok"), "ok");
  await handle.deactivate();
  assert.equal(runtime.commands.has("test.echo"), false);
});

test("request contributions route a response through the host runtime", async () => {
  const runtime = createTestRuntime();
  const handle = await registerAbility(runtime, manifest, {
    activate(api) { api.registerRequest({ id: "test.double", execute: (value) => Number(value) * 2 }); }
  }, { grantedPermissions: manifest.permissions });
  await handle.activate();
  assert.equal(await runtime.request("test.double", 21, "com.pab.test"), 42);
  await handle.deactivate();
  assert.equal(runtime.requests.has("test.double"), false);
});
