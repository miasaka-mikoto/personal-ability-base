#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const mainSource = await readFile(new URL("./src/main.ts", import.meta.url), "utf8");
const adapterSource = await readFile(new URL("./src/adapter.ts", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const css = await readFile(new URL("./src/styles.css", import.meta.url), "utf8");

// Node 22+ can strip TypeScript syntax without installing a compiler. This
// catches malformed source early in minimal/offline environments.
stripTypeScriptTypes(mainSource);
stripTypeScriptTypes(adapterSource);
assert.match(html, /src="\/src\/main\.ts"/);
for (const marker of ["Ability Store", "Ctrl", "loadouts", "data-install", "command-palette"]) assert.ok(mainSource.includes(marker), `missing UI marker: ${marker}`);
for (const marker of ["PABCore", "localStorage", "installAbility", "disableAbility", "enableAbility", "updateAbility", "uninstallAbility", "activateLoadout"]) assert.ok(adapterSource.includes(marker), `missing adapter marker: ${marker}`);
for (const marker of ["Disable ability", "Uninstall module", "Keep my data"]) assert.ok(mainSource.includes(marker), `missing lifecycle marker: ${marker}`);
for (const marker of ["@media", ".hero-card", ".store-grid", ".command-palette"]) assert.ok(css.includes(marker), `missing style marker: ${marker}`);
console.log("PAB dashboard smoke: PASS");
