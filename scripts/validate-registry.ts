#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateRegistry } from "../packages/registry-security/src/registry.ts";

const path = process.argv[2] ?? "registry/registry.example.json";
const document = JSON.parse(await readFile(path, "utf8"));
const checked = validateRegistry(document);
console.log(`✓ Valid Registry: ${checked.abilities.length} abilities, ${(checked.packs ?? []).length} packs`);
