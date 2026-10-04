import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/pab.mjs", import.meta.url));
const run = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("create → validate → build → pack smoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "pab-cli-test-"));
  try {
    let result = await run(["create", "test-ability", "--dir", root], root);
    assert.equal(result.code, 0, result.stderr);
    await rm(join(root, "test-ability", "src", "index.js"));
    await writeFile(join(root, "test-ability", "src", "index.ts"), "interface Greeting { text: string }\nexport default { activate(api: unknown): Greeting { return { text: 'ok' }; } };\n");
    result = await run(["validate", join(root, "test-ability")], root);
    assert.equal(result.code, 0, result.stderr);
    result = await run(["build", join(root, "test-ability")], root);
    assert.equal(result.code, 0, result.stderr);
    const info = JSON.parse(await readFile(join(root, "test-ability", "dist", "build-info.json"), "utf8"));
    assert.match(info.entrySha256, /^[a-f0-9]{64}$/);
    const built = await readFile(join(root, "test-ability", "dist", "index.js"), "utf8");
    assert.doesNotMatch(built, /interface Greeting/);
    result = await run(["pack", join(root, "test-ability"), "--out", join(root, "test.pab")], root);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
