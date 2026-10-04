# PAB Ability SDK

The Ability SDK is the stable boundary between a third-party module and
Personal Ability Base Core. An Ability is a versioned package with one
manifest and one portable JavaScript entry point. It does not import Core
internals, read the user database directly, or assume a browser/desktop UI.

## Minimal module

```text
my-ability/
├── manifest.json
├── README.md
├── src/index.js       # authoring source
└── dist/index.js      # package entry produced by `pab build`
```

```js
import { defineAbility } from "@pab/ability-sdk";

export default defineAbility({
  activate(api) {
    api.registerCommand({
      id: "com.example.hello",
      title: "Say hello",
      execute: () => api.showNotification({ title: "Hello", level: "success" })
    });
  },
  deactivate(api) {
    api.log("info", "Ability stopped");
  }
});
```

Core loads the manifest, checks platform/permissions/signature, imports
`entry`, and calls `activate(api)`. Core can unload the module by calling
`deactivate(api)` and disposing the API context. A module never receives the
raw Core object.

Hosts and test harnesses can use `registerAbility(runtime, manifest, module)`
to get an idempotent `{ activate, deactivate, update }` lifecycle handle. The
official Core uses the same contract through its controlled Runtime Adapter.

## Manifest contract

`schemas/ability-manifest.schema.json` is the canonical JSON Schema. The SDK
also exports `validateManifest()` and `assertValidManifest()` so the same
rules can run offline in the CLI and in Core. Required fields are:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Manifest schema migration boundary (`1`) |
| `id` | Stable lowercase module ID; never change after release |
| `version` | Semantic module version |
| `minCoreVersion` | Minimum compatible PAB Core |
| `platforms` | `windows`, `android`, `linux`, `macos`, `ios`, or `web` |
| `permissions` | Explicit capability requests; `[]` is valid |
| `dependencies` | Required Ability IDs and semver ranges |
| `optionalDependencies` | Optional integrations |
| `conflicts` | Ability IDs/ranges that cannot be active together |
| `contributes` | Pages, cards, commands, search providers, workflows, settings |
| `entry` | Package-relative runtime entry, normally `dist/index.js` |

Use `source.kind` (`official`, `verified`, `community`, `local`, or
`developer`) and `integrity.sha256`/`integrity.signature` when publishing to
the Registry.

## SDK API

`AbilityContext` exposes only controlled APIs:

- `registerPage`, `registerCard`, `registerCommand`,
  `registerRequest`, `registerSearchProvider`, `registerWorkflow`, `registerSetting`
- `subscribeEvent`, `publishEvent`, `request`
- `openPage`, `showNotification`
- `storage.get/set/delete/keys` (namespaced to the Ability)
- `sharedStorage.get/set` (requires `storage.shared`)
- `memory.query/write` (requires `memory.read`/`memory.write`)
- `requestPermission`, `getSettings`, `setSettings`, `log`

All event payloads travel through the Ability Bus. Cross-module database
access is intentionally not part of the SDK.

`@pab/ability-sdk/events` exports canonical constants such as
`EVENTS.MEMORY_CREATED`, `EVENTS.SKILL_STARTED`, and
`EVENTS.DECISION_REVIEWED`; custom events should use a namespaced prefix.

## CLI

The dependency-free CLI is `packages/ability-cli/bin/pab.mjs`:

```bash
pab create conversation-gym --dir abilities
pab validate abilities/conversation-gym
pab build abilities/conversation-gym
pab dev abilities/conversation-gym --check
pab pack abilities/conversation-gym --out releases/conversation-gym-0.1.0.pab
```

`pab pack` creates a portable ZIP-based `.pab` package in-process, so it does
not depend on a system `zip` binary. It includes `manifest.json`, `dist/`, and
README but never includes user data.

Authoring files may be JavaScript or Node-compatible TypeScript. `pab build`
strips/transforms TypeScript into the portable JavaScript `dist/` entry on
Node 22+; a module that uses TypeScript should declare Node 22+ in its
developer setup, while its published package remains ordinary JavaScript.

## Developing for Windows and Android

Write only against the SDK API. The Windows shell, Android shell, and future
web shell provide separate Runtime Adapters implementing the same methods.
Avoid Node-only globals, filesystem access, or native binaries in module
entries. If a heavy calculation is needed, place it behind a future WASM
capability and declare that requirement in the manifest.

## Permissions and data retention

Permissions are declared before installation and can be denied/revoked by
Core. `storage.private` is namespaced by Ability ID. Disabling or uninstalling
an Ability does not remove that namespace; Core decides whether to retain it
and can offer restore on reinstall.

## Official examples

`abilities/pocket-cortex` demonstrates capture/recall and memory events.
`abilities/decision-forge` demonstrates private state, optional dependencies,
decision records, and review events. `abilities/skill-hud` demonstrates a
small event-driven execution HUD. Each has a built `dist/index.js`, so Core
can load it immediately; rerun `pab build` after source edits.
