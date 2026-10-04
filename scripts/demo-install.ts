import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbilityInstaller,
  JsonPackageExtractor,
  MemoryPackageDownloader,
  ModuleStore,
  TrustPolicy,
  sha256Hex,
} from "../packages/registry-security/src/index.ts";

const root = await mkdtemp(join(tmpdir(), "pab-demo-install-"));
try {
  const payload = new TextEncoder().encode(JSON.stringify({ files: {
    "manifest.json": JSON.stringify({
      schemaVersion: 1,
      id: "com.pab.demo",
      name: "PAB Demo",
      displayName: "PAB Demo",
      version: "1.0.0",
      description: "Installer smoke ability",
      author: "Personal Ability Base",
      minCoreVersion: "0.1.0",
      platforms: ["windows", "android"],
      permissions: [],
      dependencies: {},
      optionalDependencies: {},
      contributes: { pages: [], commands: [], cards: [], searchProviders: [], workflows: [], settings: [] },
      entry: "dist/index.js"
    }),
    "dist/index.js": "export default {};"
  }}));
  const url = "memory://com.pab.demo/1.0.0";
  const entry = {
    schemaVersion: 1,
    id: "com.pab.demo",
    name: "PAB Demo",
    version: "1.0.0",
    repository: "https://github.com/PersonalAbilityBase/ability-demo",
    packageUrl: url,
    sha256: sha256Hex(payload),
    trust: "developer" as const,
    platforms: ["windows", "android"] as const,
    permissions: [],
    minCoreVersion: "0.1.0",
  };
  const store = new ModuleStore({ root });
  const installer = new AbilityInstaller({
    store,
    downloader: new MemoryPackageDownloader({ [url]: payload }),
    extractor: new JsonPackageExtractor(),
    trustPolicy: new TrustPolicy({ allowedLevels: ["developer"] }),
  });
  const result = await installer.install(entry, { platform: "windows", coreVersion: "0.1.0", approvedPermissions: [] });
  assert.equal(result.activated, true);
  assert.match(result.path, /com\.pab\.demo/);
  console.log("PAB registry installer smoke: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
