#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const abilities = ["pocket-cortex", "skill-hud", "decision-forge", "capture-everything"];
const cli = fileURLToPath(new URL("../packages/ability-cli/bin/pab.mjs", import.meta.url));

for (const name of abilities) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "validate", `abilities/${name}`], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (result !== 0) process.exit(result);
}
console.log(`Validated ${abilities.length} official abilities.`);
