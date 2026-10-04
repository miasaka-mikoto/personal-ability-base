# Windows / Android host adapter boundary

The executable scaffold for this boundary lives in
`packages/platform-adapters` (`@pab/platform-adapters`). It has no native
runtime dependency, so the same tests run in Node and in a browser preview.
Use `createWindowsWebView2Adapter`, `createWindowsTauriAdapter`,
`createAndroidWebViewAdapter`, or `createAndroidCapacitorAdapter`; each
implements the same `HostAdapter` contract.

PAB keeps one Ability package and swaps only the host capabilities. The
Dashboard talks to `window.PABCore`; a native shell may implement that bridge
with WebView2/Tauri on Windows or WebView/Capacitor on Android.

## Shared bridge responsibilities

- `getSnapshot`, install/update/enable/disable/uninstall
- Loadout activation and command execution
- permission prompts (`allow`, `deny`, `ask`)
- notification and page navigation
- registry refresh and offline-cache status

The host package also exposes one registration/routing API for:

- `registerGlobalHotkey()` / `dispatchGlobalHotkey()`
- `registerQuickTile()` / `triggerQuickTile()`
- `registerShareTarget()` / `receiveShare()`
- `showNotification()` / `dismissNotification()`
- async `storage` with an app-private namespace and deterministic fallback

Native shells inject a transport with `invoke(method, payload)` and optionally
`onMessage(handler)`. The transport operation names are exported as
`HostMethod`; no Ability imports a native SDK.

## Windows adapter targets

- global hotkey routes to `capture-everything.quick-capture`, `core.recall`, or
  another registered Ability command;
- WebView2/Tauri filesystem adapter maps the Core storage contract to an
  application-private directory;
- native notifications and an updater remain outside Ability code.

`createWebView2Transport()` sends `pab.host.request` through
`chrome.webview.postMessage`. `createTauriTransport()` calls
`pab_<operation>` through Tauri `core.invoke`.

## Android adapter targets

- Share Target and notification actions route to the Capture Everything
  command; the Ability then publishes `capture.created` through the Core bus;
- Quick Tile, launcher shortcuts, and widget buttons execute registered
  commands;
- Room/SQLite or app-private files implement the same async storage contract.

`createAndroidWebViewTransport()` sends the same request envelope to
`PABAndroid.postMessage`; `createCapacitorTransport()` calls the optional
`PABHost` plugin. Native-to-JavaScript events are normalized to
`host.hotkey`, `host.quickTile`, `host.share`, and `host.notificationAction`.

Run the dependency-free adapter tests with:

```bash
node --test packages/platform-adapters/test/*.test.mjs
```

No Ability is allowed to ship Kotlin/Java or Windows-native binaries as its
normal package entry. A future WASM capability can be added as an explicit
runtime type after a separate sandbox and resource-limit review.
