#!/usr/bin/env node

/**
 * Dependency-free v0.2 lifecycle acceptance test.
 *
 * This deliberately runs against the same Core/runtime APIs used by the
 * native shells.  It does not mock ModuleManager or call an Ability's entry
 * point directly: packages are discovered from their manifests, loaded by a
 * host loader, and exercised through the command/event buses.
 *
 * By default Capture Everything is required.  `--allow-fallback` is useful
 * while bootstrapping a source checkout before that official package has been
 * added; it runs the identical lifecycle against Pocket Cortex instead.
 */

import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ErrorCode,
  MemoryStorage,
  PABCore,
} from "../packages/core/src/index.js";
import {
  AndroidHostAdapter,
  WindowsHostAdapter,
} from "../packages/platform-adapters/src/index.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptRoot, "..");
const abilitiesRoot = join(projectRoot, "abilities");
const allowFallback = process.argv.includes("--allow-fallback");
const quietLogger = { log() {}, info() {}, warn() {}, error() {} };

// A source checkout can run this lane before `npm install`: official Ability
// bundles import the workspace SDK by its package name.  Mirror npm's
// workspace link just like the regular smoke lane does; an existing install
// or a read-only host is left untouched.
const sdkLink = join(projectRoot, "node_modules", "@pab", "ability-sdk");
try {
  await mkdir(dirname(sdkLink), { recursive: true });
  await symlink(join(projectRoot, "packages", "ability-sdk"), sdkLink, "dir");
} catch {
  // The link may already exist, or the host may disallow symlink creation.
}

/** @typedef {{manifest:object, packageRef:string, source:string, loader:Function}} AbilityPackage */

/**
 * Read an installable source package using the same manifest/entry contract a
 * GitHub release package uses.  Keeping this helper here makes the E2E useful
 * without npm, a bundler, or a network connection.
 *
 * @param {string} directoryName
 * @returns {Promise<AbilityPackage|null>}
 */
async function readLocalPackage(directoryName) {
  const directory = join(abilitiesRoot, directoryName);
  try {
    await access(join(directory, "manifest.json"));
  } catch {
    return null;
  }
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const entryPath = join(directory, manifest.entry);
  const packageRef = pathToFileURL(entryPath).href;
  return {
    manifest,
    packageRef,
    source: "official-local",
    // The runtime supplies the manifest/packageRef arguments.  Importing by
    // URL keeps this loader equivalent on Windows, Android WebViews, and the
    // headless Node host (native shells can replace only this adapter).
    loader: async () => import(packageRef),
  };
}

function bumpPatch(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) throw new Error(`Cannot bump non-semver version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`;
}

function commandCandidates(core, abilityId) {
  return core.commands
    .list({ abilityId })
    .filter((command) => /capture|quick|inbox|thought/i.test(`${command.id} ${command.title ?? ""}`))
    .sort((a, b) => {
      const score = (command) => command.id.endsWith(".capture") ? 0 : /capture/i.test(command.id) ? 1 : 2;
      return score(a) - score(b);
    });
}

async function main() {
  const pocket = await readLocalPackage("pocket-cortex");
  const officialCapture = await readLocalPackage("capture-everything");
  if (!officialCapture && !allowFallback) {
    throw new Error(
      "Capture Everything is not present at abilities/capture-everything. " +
      "Finish the official Ability package or run `node scripts/e2e-v02.mjs --allow-fallback` while bootstrapping."
    );
  }
  if (!pocket) throw new Error("Pocket Cortex is required by the v0.2 E2E fixture");

  const target = officialCapture ?? pocket;
  const usingFallback = !officialCapture;
  const packages = new Map([[pocket.manifest.id, pocket], [target.manifest.id, target]]);
  const registryEntries = [...new Map([...packages.values()].map((pkg) => [pkg.manifest.id, pkg.manifest])).values()];
  let online = true;
  const registry = {
    async refresh() {
      if (!online) throw new Error("offline (intentional E2E condition)");
      return {
        document: { schemaVersion: 1, abilities: registryEntries },
        meta: { stale: false, source: "e2e-memory-registry" },
      };
    },
    async load() { return null; },
    list() { return registryEntries; },
  };

  const core = new PABCore({
    version: "0.1.0",
    platform: "windows",
    storage: new MemoryStorage(),
    registry,
    promptPermission: async () => "allow",
    downloadPackage: async (id) => {
      const pkg = packages.get(id);
      if (!pkg) throw new Error(`E2E package downloader cannot resolve ${id}`);
      return pkg;
    },
    loadAbility: async ({ manifest, packageRef }) => {
      const pkg = packages.get(manifest.id);
      if (pkg) return pkg.loader({ manifest, packageRef });
      return import(packageRef);
    },
    logger: quietLogger,
  });

  const observedEvents = [];
  const observedPayloads = [];
  const observedStages = [];
  const removeEventObserver = core.eventBus.subscribe("**", (event) => {
    if (/^(capture\.created|memory\.created|ability\.(activated|deactivated|disabled|enabled|installed|rolled_back|uninstalled)|command\.executed)$/.test(event.type)) {
      observedEvents.push(event.type);
      observedPayloads.push(event.payload);
    }
  });
  const removeProgressObserver = core.eventBus.subscribe("ability.install.progress", (event) => {
    observedStages.push(event.payload?.stage);
  });

  let stopped = false;
  try {
    await core.start();

    // Registry refresh and stale-cache fallback are part of the install path;
    // exercising them here catches regressions that a direct package install
    // would hide.
    const fresh = await core.refreshRegistry({ reason: "e2e" });
    assert.equal(fresh.meta?.stale, false, "online registry refresh should be fresh");
    online = false;
    const stale = await core.refreshRegistry({ reason: "e2e-offline" });
    assert.equal(stale.meta?.stale, true, "offline registry refresh should use the cached document");
    online = true;

    const pocketInstall = await core.installAbility(pocket);
    assert.equal(pocketInstall.record.activeVersion, pocket.manifest.version);
    assert.equal(core.runtime.isActive(pocket.manifest.id), true);

    if (!usingFallback) {
      const targetInstall = await core.installAbility(target);
      assert.equal(targetInstall.record.activeVersion, target.manifest.version);
      assert.equal(core.runtime.isActive(target.manifest.id), true);
    }

    const targetId = target.manifest.id;
    const candidates = commandCandidates(core, targetId);
    assert.ok(candidates.length > 0, `${targetId} must contribute a capture command`);

    // The same Ability command is reachable through both first-priority host
    // surfaces. These adapters have no native dependency in the E2E; a real
    // WebView2/Capacitor transport can replace only the transport object.
    const hostCommand = (commandId, input, options) => core.commands.execute(commandId, input, options);
    const windowsHost = new WindowsHostAdapter({ commandExecutor: hostCommand });
    await windowsHost.start();
    await windowsHost.registerGlobalHotkey({ id: "e2e-windows-capture", binding: "Ctrl+Shift+Space", commandId: candidates[0].id });
    const windowsToken = `PAB v0.2 Windows host ${Date.now()}`;
    await windowsHost.dispatchGlobalHotkey("Ctrl+Shift+Space", { text: windowsToken, channel: "windows-hotkey" });
    await windowsHost.stop();
    const androidHost = new AndroidHostAdapter({ commandExecutor: hostCommand });
    await androidHost.start();
    await androidHost.registerShareTarget({ id: "e2e-android-share", commandId: candidates[0].id });
    const androidToken = `PAB v0.2 Android host ${Date.now()}`;
    await androidHost.receiveShare({ text: androidToken, channel: "android-share" }, "e2e-android-share");
    await androidHost.stop();
    assert.ok((await core.memory.query({ text: windowsToken })).length > 0, "Windows host must reach the Ability command");
    assert.ok((await core.memory.query({ text: androidToken })).length > 0, "Android host must reach the Ability command");

    const token = `PAB v0.2 E2E capture ${Date.now()}`;
    const captureInput = {
      text: token,
      content: token,
      body: token,
      value: token,
      title: "Lifecycle acceptance capture",
      tags: ["e2e", "capture"],
    };
    let captureCommand;
    let captureResult;
    const commandErrors = [];
    for (const candidate of candidates) {
      try {
        const before = observedEvents.length;
        const result = await core.commands.execute(candidate.id, captureInput, { source: "e2e" });
        const emitted = observedEvents.slice(before);
        const data = await core.exportAbilityData(targetId);
        const hasToken = JSON.stringify(data).includes(token) || JSON.stringify(result ?? {}).includes(token);
        if (emitted.some((type) => type === "capture.created" || type === "memory.created") || hasToken) {
          captureCommand = candidate;
          captureResult = result;
          break;
        }
      } catch (error) {
        commandErrors.push(`${candidate.id}: ${error?.message ?? error}`);
      }
    }
    assert.ok(captureCommand, `${targetId} capture command did not accept the E2E payload (${commandErrors.join("; ")})`);
    assert.ok(
      observedEvents.includes("capture.created") || observedEvents.includes("memory.created"),
      "capture command must publish capture.created or memory.created on the Ability Bus"
    );
    assert.ok(
      observedPayloads.some((payload) => JSON.stringify(payload ?? {}).includes(token)),
      "capture event payload must carry the captured content"
    );
    const globalMemories = await core.memory.query({ text: token });
    const ownedData = await core.exportAbilityData(targetId);
    assert.ok(globalMemories.length > 0 || JSON.stringify(ownedData).includes(token) || JSON.stringify(captureResult ?? {}).includes(token), "capture must create durable user data");

    // Disable removes runtime contributions without uninstalling the module.
    await core.disableAbility(targetId);
    assert.equal(core.runtime.isActive(targetId), false);
    await assert.rejects(
      () => core.commands.execute(captureCommand.id, captureInput),
      (error) => error?.code === ErrorCode.COMMAND_NOT_FOUND
    );

    // Enable rehydrates the same version and restores the command.
    await core.enableAbility(targetId);
    assert.equal(core.runtime.isActive(targetId), true);
    assert.ok(core.commands.get(captureCommand.id), "enable must restore Ability contributions");

    // Update to a synthetic release, then roll back to the installed release.
    // The executable package is intentionally unchanged; only the signed
    // manifest/version moves, matching a release metadata update test.
    const originalVersion = target.manifest.version;
    const nextVersion = bumpPatch(originalVersion);
    const nextPackage = {
      ...target,
      manifest: { ...target.manifest, version: nextVersion, releaseNotes: "v0.2 E2E synthetic release" },
    };
    const updated = await core.updateAbility(nextPackage, { force: true });
    assert.equal(updated.record.activeVersion, nextVersion);
    assert.ok((await core.moduleStore.get(targetId)).history.includes(originalVersion), "update must preserve the previous version for rollback");
    const rolledBack = await core.rollbackAbility(targetId, originalVersion);
    assert.equal(rolledBack.activeVersion, originalVersion);
    assert.equal(core.runtime.isActive(targetId), true);
    assert.ok(core.commands.get(captureCommand.id), "rollback must reactivate the previous package");

    // Uninstall removes module code/registration but keeps user data by
    // default.  Reinstalling the package must find that data again.
    await core.uninstallAbility(targetId);
    assert.equal(await core.moduleStore.has(targetId), false);
    assert.equal(core.commands.get(captureCommand.id), undefined);
    const retainedSnapshot = await core.getDashboardSnapshot();
    assert.equal(retainedSnapshot.abilities.find((item) => item.id === targetId)?.dataRetained, true);
    const afterUninstall = await core.memory.query({ text: token });
    const retainedData = await core.exportAbilityData(targetId);
    assert.ok(afterUninstall.length > 0 || JSON.stringify(retainedData).includes(token), "uninstall must preserve user data by default");

    await core.installAbility(target);
    assert.equal(core.runtime.isActive(targetId), true);
    assert.ok(core.commands.get(captureCommand.id), "reinstall must restore the Ability command");
    const afterReinstall = await core.memory.query({ text: token });
    const restoredData = await core.exportAbilityData(targetId);
    assert.ok(afterReinstall.length > 0 || JSON.stringify(restoredData).includes(token), "reinstall must retain the previous Ability data");

    assert.ok(observedStages.includes("discover"), "install progress must include discover");
    assert.ok(observedStages.includes("verify"), "install progress must include verify");
    assert.ok(observedStages.includes("dependencies"), "install progress must include dependencies");
    assert.ok(observedStages.includes("installed"), "install progress must include installed");
    assert.ok(observedStages.includes("activated"), "install progress must include activated");

    await core.stop();
    stopped = true;
    console.log(`PAB v0.2 lifecycle E2E: PASS (${targetId}${usingFallback ? "; fallback=pocket-cortex" : ""})`);
    console.log(JSON.stringify({
      abilityId: targetId,
      version: originalVersion,
      command: captureCommand.id,
      observedEvents: [...new Set(observedEvents)],
      installStages: [...new Set(observedStages)],
      registryOfflineCache: true,
      updateRollback: true,
      uninstallKeepsData: true,
      hostRouting: { windowsGlobalHotkey: true, androidShareTarget: true },
    }, null, 2));
  } finally {
    removeEventObserver();
    removeProgressObserver();
    if (!stopped) await core.stop();
  }
}

main().catch((error) => {
  console.error(`PAB v0.2 lifecycle E2E: FAIL\n${error?.stack ?? error}`);
  process.exitCode = 1;
});
