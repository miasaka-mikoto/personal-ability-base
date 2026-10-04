# `@personal-ability-base/core`

The Core OS for **Personal Ability Base (PAB)**. It is deliberately UI and
storage-backend neutral so one Ability package can run in a Windows shell, an
Android shell, or a test process.

## What Core owns

- manifest validation and semantic-version/dependency resolution
- event, command, and request/response buses
- controlled Ability Runtime and contribution registry
- permission decisions (`allow`, `deny`, `ask`)
- versioned module metadata, update/rollback and uninstall semantics
- persisted update policies (`automatic`, `manual`, `ignore`, or `pinned`)
- local-first memory/search APIs
- backup/restore and diagnostics
- persistent Loadouts that change focus without uninstalling abilities
- repair/reset plus per-Ability data export/import (with explicit data removal)

Core never stores an Ability's user data inside the module directory. Module
versions are metadata under `core/modules`; Ability data is namespaced below
`userdata/abilities/<ability-id>` and remains after uninstall by default.

## Host integration

```js
import { PABCore, MemoryStorage } from "@personal-ability-base/core";

const core = new PABCore({
  platform: "windows", // Android shell passes "android"
  storage: new MemoryStorage(), // replace with SQLite/Room adapter in production
  promptPermission: async ({ abilityId, permission }) => {
    return nativeConsentSheet({ abilityId, permission });
  },
  loadAbility: ({ packageRef, entry }) => hostModuleLoader(packageRef, entry),
  downloadPackage: (idOrUrl, options) => githubReleaseDownloader(idOrUrl, options),
  verifyHash: (pkg, expected) => verifyDownloadedBytes(pkg.bytes, expected),
  verifySignature: (pkg) => verifyOfficialSignature(pkg),
  ui: { openPage, showNotification },
});

await core.start();
await core.installAbility(packageObject);

// Update checks can be automatic or explicitly user-triggered. Policies are
// persisted by the Core storage adapter and do not live inside module data.
await core.setAbilityUpdatePolicy("com.pab.example", { mode: "manual" });
```

The package loader is an explicit host callback. Core does not execute native
Kotlin/Java or arbitrary downloaded binaries. A production shell should load
the JavaScript/HTML package in a restricted worker/WebView bridge and expose
only the `AbilityContext` APIs.

## Ability context

An Ability receives `registerPage`, `registerCard`, `registerCommand`,
`registerRequest`, `registerSearchProvider`, `registerWorkflow`, `subscribeEvent`,
`publishEvent`, namespaced `storage`, `memory.query/write`, and permission
gates. The runtime automatically removes contributions and subscriptions on
disable, update, rollback, or stop.

## Stable failure codes

`PabError.code` is intended for native UI translation. Examples include
`HASH_MISMATCH`, `SIGNATURE_INVALID`, `DEPENDENCY_CONFLICT`,
`CORE_VERSION_TOO_OLD`, `PLATFORM_UNSUPPORTED`, `PERMISSION_DENIED`, and
`ROLLBACK_UNAVAILABLE`; installers should never collapse these to “Unknown
Error”.

## Test

```sh
npm test
```

The tests exercise manifest/range validation, event/command routing, cycle
detection, permission prompts, installation, activation, update, rollback,
disable/enable, and preservation of user data after uninstall.
