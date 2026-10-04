# PAB roadmap

## v0.1 — delivered in this repository

- Core / Ability / User Data boundaries
- controlled JS SDK and Runtime contract
- Event, Command, and Request/Response buses
- GitHub-compatible offline Registry and Store facade
- SHA-256 + Ed25519 trust policy, permission review, dependency resolution,
  safe ZIP extraction, migration hooks, rollback, repair, and retained data
- Dashboard / Store / Loadout / Command Palette prototype
- Windows/Android-neutral example Abilities and `pab` CLI

## v0.2 — host contract and lifecycle (scaffold delivered)

Delivered in the current source tree:

- Capture Everything official Ability, including quick capture, private inbox,
  memory linkage, and `capture.created` event routing.
- Shared `@pab/platform-adapters` contract for Windows WebView2/Tauri and
  Android WebView/Capacitor transports, with deterministic tests.
- Registry/loadout metadata, offline acceptance lane, deterministic source
  packaging, and lifecycle E2E for install → activate → disable/enable →
  update/rollback → uninstall/restore.

Still requires a native toolchain and protected signing environment:

- WebView2/Tauri Windows host with global hotkey, notifications, private
  filesystem, signed updater, and a worker-based module sandbox
- Android WebView/Capacitor host with Share Target, Quick Tile, widget,
  launcher shortcut, Room/SQLite storage, and notification actions
- Replace the in-memory demo loader with a capability bridge and resource
  limits; downloaded Ability code must not run in the host UI process

## v0.3 — storage adapters and ecosystem

- SQLite/FTS-backed Core storage and encrypted backup keys
- optional read-only `pab-storage-siyuan` adapter after compatibility tests
- official release signing pipeline, reproducible package hashes, CI registry
  generation, screenshots, and signed Windows/Android artifacts
- WASM runtime lane only after separate memory, CPU, and permission review

The roadmap is intentionally separate from `STATUS.md` and `ACCEPTANCE.md`:
the scaffold items above are source-level contracts and tests, not claims that
native installers, a production remote registry, or signed artifacts already
exist.
