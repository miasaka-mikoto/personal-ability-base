#!/usr/bin/env node
/** Load and activate one Ability against the SDK's deterministic local host. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestRuntime } from "../../ability-sdk/testing.js";
import { registerAbility } from "../../ability-sdk/index.js";

const moduleDir = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(await readFile(resolve(moduleDir, "manifest.json"), "utf8"));
const module = await import(pathToFileURL(resolve(moduleDir, manifest.entry)).href);
const runtime = createTestRuntime({ grantedPermissions: manifest.permissions, logger: (entry) => console.log(`[${entry.level}] ${entry.message}`) });
const handle = await registerAbility(runtime, manifest, module, { grantedPermissions: manifest.permissions });
await handle.activate();
console.log(`PAB dev host: ${manifest.id}@${manifest.version}`);
console.log(`Contributions: ${JSON.stringify(handle.api.getContributions(), null, 2)}`);
console.log("Ready. Edit source, rebuild, or press Ctrl+C to stop.");

const stop = async () => { await handle.deactivate(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
// Keep the host alive for interactive development.
await new Promise(() => {});
