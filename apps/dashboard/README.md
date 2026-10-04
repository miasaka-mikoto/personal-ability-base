# PAB Dashboard

The dashboard is the UI shell for Personal Ability Base. It is deliberately
kept separate from Core and communicates through `src/adapter.ts` only. The
same UI can therefore run in a Vite browser preview, a Windows native shell,
or an Android WebView/Capacitor host.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. `npm run build` performs a strict
TypeScript check before producing `dist/`.

`npm run smoke` and `node preview.mjs` also work without installing any
packages on Node 22+ (they use Node's built-in TypeScript stripper). The
preview server is intentionally a source inspector; use Vite for production
bundling.

The shell has an offline-first local adapter, so it is usable before the Core
bridge is connected. It persists its demo registry and UI state in
`localStorage` under `pab.dashboard.snapshot.v1`.

## Core bridge

The native shell may expose a small `window.PABCore` object before loading the
dashboard:

```ts
window.PABCore = {
  getSnapshot: async () => core.getDashboardSnapshot(),
  installAbility: (id) => core.modules.install(id),
  updateAbility: (id) => core.modules.update(id),
  disableAbility: (id) => core.disableAbility(id),
  enableAbility: (id) => core.enableAbility(id),
  // The dashboard passes keepData=true by default. Core keeps data in its
  // separate namespace unless the user explicitly opts out.
  uninstallAbility: (id, keepData) => core.uninstallAbility(id, { keepData }),
  activateLoadout: (id) => core.loadouts.activate(id)
};
```

Only these methods are required. Missing methods fall back to the local
adapter, which makes development and offline registry browsing safe.

## Included interaction prototype

- Ability Dashboard with quick actions and active loadout
- Ability Store with cached registry, search, category filters, source pills,
  install/update actions, and module details
- Staged install/update modal showing discover → download → hash verify →
  permissions → register → activate
- My Abilities manager with update banner and data-preserving disable flow
- Loadouts (Daily, Developer, Researcher, Japanese)
- Activity audit trail and local-first settings
- `Ctrl/Cmd + K` command palette and `/` store search shortcut
- Responsive layout for narrow Android-width screens
