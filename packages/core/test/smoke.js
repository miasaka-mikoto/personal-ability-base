import { PABCore, MemoryStorage } from "../src/index.js";

const core = new PABCore({ platform: "windows", storage: new MemoryStorage() });
await core.start();
const diagnostics = await core.diagnostics();
console.log(JSON.stringify({ ok: true, version: diagnostics.coreVersion, platform: diagnostics.platform }));
await core.stop();

