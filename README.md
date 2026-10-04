# Personal Ability Base (PAB) · 个人能力基地

Personal Ability Base is a local-first, modular operating system for personal
capabilities. The lightweight Core owns infrastructure; each real capability
is an independently versioned **Ability Module** that can be installed,
enabled, updated, rolled back, or removed without deleting its user data.

This repository is an independent implementation. It does not fork or vendor
SiYuan. A dated evaluation of SiYuan and the planned adapter boundary is in
[`docs/architecture/siyuan-evaluation.md`](docs/architecture/siyuan-evaluation.md).

## What works in v0.2 scaffold

- Platform-neutral PAB Core in `packages/core`.
- Controlled JavaScript Ability Runtime with pages, cards, commands, search
  providers, workflows, settings, events, request/response handlers,
  permission gates, and namespaced storage.
- Versioned install/update/rollback/disable/uninstall lifecycle with default
  keep-data semantics.
- Core backup/restore, per-Ability data export/import, repair/reset, and
  persistent Loadouts that never conflate module code with user data.
- Offline-first Registry cache, GitHub-compatible downloader, SHA-256 and
  Ed25519 verification, trust levels, dependency resolution, safe ZIP
  extraction, migration hooks, and install progress stages in
  `packages/registry-security`.
- A `GitHubAbilityStore` facade that refreshes/caches a raw GitHub Registry,
  searches it offline, installs individual abilities or packs, and exposes
  update/enable/disable/rollback/uninstall operations.
- Official SDK, manifest schema, starter template, and `pab` CLI in
  `packages/ability-sdk`, `packages/ability-cli`, and `templates/`.
- Four runnable official abilities: Pocket Cortex, Skill HUD, Decision Forge,
  and Capture Everything. The latter exposes one portable quick-capture path
  for desktop hotkeys, Android sharing, and `capture.created` events.
- Responsive Ability Dashboard / Store / Loadouts / Command Palette in
  `apps/dashboard`, with a local offline adapter and a narrow native-shell
  bridge.
- Dependency-free Windows/Android host adapters in
  `packages/platform-adapters`, with WebView2/Tauri and WebView/Capacitor
  transport contracts, global hotkey, Quick Tile, Share Target, notification,
  and private-storage routing.
- A real v0.2 lifecycle E2E covering registry cache fallback, install/activate,
  command and event routing, disable/enable, update/rollback, uninstall with
  retained data, and reinstall recovery.
- Reproducible source-only release packaging with SHA-256 sidecars and an
  explicit unsigned/native-artifact status.

The current deliverable is a tested Core and a UI prototype rather than a
signed Windows installer or Play Store APK. The same Runtime contract is
designed for a Windows shell, an Android WebView/Capacitor shell, and future
native adapters; see [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Quick start (no network required)

Node.js 24+ is sufficient for the Core, SDK, registry tests, and dashboard
source smoke test. No paid model or API key is used.

```bash
npm test
npm run smoke
npm run validate:abilities
npm run e2e:v02
npm run dashboard:smoke
```

For the no-network release/host checks:

```bash
npm run check:offline
npm run platform:verify
npm run release:source
npm run release:check
```

The release lane creates a deterministic source-only ZIP and SHA-256 manifest.
It does not produce a signed Windows installer or Android APK/AAB. The
Windows launcher and Android bridge scaffold are documented in
[`ACCEPTANCE.md`](ACCEPTANCE.md).

To inspect the dashboard without installing Vite/TypeScript dependencies:

```bash
node apps/dashboard/preview.mjs
# open http://localhost:4173
```

For the full Vite developer experience:

```bash
npm install
npm run dashboard:dev
# or: npm run dashboard:build
```

## Create an Ability

```bash
npm run pab -- create conversation-gym --dir abilities
npm run pab -- validate abilities/conversation-gym
npm run pab -- build abilities/conversation-gym
npm run pab -- pack abilities/conversation-gym
```

An Ability entry receives only the SDK context. It must not import Core
internals, access the host filesystem, or download native binaries. Declare
permissions and dependencies in `manifest.json`; the host decides how a
permission prompt and a platform adapter are presented.

For a host-side GitHub Store, see the no-network-compatible wiring example in
[`packages/registry-security/README.md`](packages/registry-security/README.md).
For lifecycle data controls, Core exposes `repairAbility`, `resetAbility`,
`exportAbilityData`, and `importAbilityData`; resetting or uninstalling code
does not delete data unless the caller explicitly opts in.

## Repository map

```text
packages/core/                 Core OS, buses, runtime, lifecycle
packages/registry-security/    Registry/cache/downloader/trust/installer
packages/ability-sdk/          Third-party Ability API and manifest helpers
packages/ability-cli/          pab create/dev/build/validate/pack
packages/platform-adapters/   Windows/Android host capability bridge
abilities/                    Official example modules
apps/dashboard/               Windows/Android-ready web UI shell
platform/                     Native-shell bridge and build scaffolds
schemas/                      Canonical Ability manifest schema
registry/                     GitHub Registry contract and local demo data
docs/                         Architecture, security, SDK, and decisions
docs/roadmap.md               Native-shell and ecosystem milestones
STATUS.md / ACCEPTANCE.md     Current v0.2 boundary and repeatable checks
```

## Security boundary

The default Store policy shows Official and Verified sources. Community,
Local, and Developer packages require an explicit trust choice. Every package
is size-limited, hash-checked, optionally Ed25519-signed, manifest-checked,
extracted into a staging directory with traversal/symlink protection, and
installed under an immutable version directory. User data is always rooted at
`userdata/abilities/<ability-id>` and is preserved by default on uninstall.

## License

PAB code in this repository is MIT unless a file says otherwise. SiYuan is not
included; if a future optional adapter links to SiYuan, keep its AGPL-3.0 and
third-party notices separate and follow the evaluation record.
