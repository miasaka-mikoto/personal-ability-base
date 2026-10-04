# `@pab/platform-adapters`

Dependency-free host bridge for Personal Ability Base (PAB). It keeps
platform code in the shell and exposes one interface to the Dashboard/Core:

- Windows WebView2 or Tauri: global hotkeys, notifications, native storage
- Android WebView or Capacitor: Quick Tile, Share Target, notifications,
  native storage
- all hosts: command routing, lifecycle events, namespaced async storage, and
  deterministic in-memory fallback for offline preview/tests

An Ability only contributes a command. It never imports WebView2, Tauri,
Android, or Capacitor packages and never ships native binaries as its normal
entry point.

## Quick start

```js
import {
  createWindowsWebView2Adapter,
  createAndroidCapacitorAdapter,
  MemoryHostStorage,
} from "@pab/platform-adapters";

const host = createWindowsWebView2Adapter({
  // The native shell may inject `chrome.webview`; no SDK is required here.
  commandExecutor: (commandId, input) => core.commands.execute(commandId, input),
  storage: new MemoryHostStorage(),
});

await host.start();
await host.registerGlobalHotkey({
  id: "capture-now",
  binding: "Ctrl+Shift+Space",
  commandId: "capture-everything.capture",
  title: "Capture now",
});
await host.showNotification({ title: "PAB", body: "Ready" });
```

Android uses the same registration contract:

```js
const host = createAndroidCapacitorAdapter({ capacitor: globalThis.Capacitor });
await host.registerQuickTile({ id: "capture", commandId: "capture-everything.quick-capture" });
await host.registerShareTarget({ id: "capture-share", commandId: "capture-everything.quick-capture" });
```

## Native transport contract

The adapters call `transport.invoke(method, payload)` and optionally listen
with `transport.onMessage(handler)`. The operation names are exported as
`HostMethod`. A shell can implement them with:

| Operation | Windows | Android |
| --- | --- | --- |
| `globalHotkey.register` | Register a Win32/WebView2 or Tauri shortcut | Not exposed by default |
| `quickTile.register` | Not exposed by default | Register an Android Quick Settings Tile |
| `shareTarget.register` | Not exposed by default | Register Android share intent target |
| `notifications.show` | Windows toast / Tauri notification | Android notification |
| `storage.*` | app-private file/SQLite | app-private SQLite/DataStore |

WebView2 sends a one-way message:

```json
{
  "type": "pab.host.request",
  "requestId": "host_req_…",
  "method": "globalHotkey.register",
  "payload": { "id": "capture-now", "binding": "Ctrl+Shift+Space" }
}
```

Tauri invokes `pab_<operation>` through `core.invoke`. Capacitor invokes the
`PABHost` plugin's `invoke({ method, payload })` method. Android WebView sends
the same request as a JSON string to `PABAndroid.postMessage`.

Native-to-JS events can be sent as `host.hotkey`, `host.quickTile`,
`host.share`, `host.notificationAction`, or `host.response`; aliases such as
`pab.hotkey` are accepted. The adapter routes these events to the registered
command and emits a normalized event for shell/UI observers.

## Security and lifecycle boundary

The bridge is not a permission bypass. Core still owns Ability permissions and
the Command Bus. Native code should validate the command ID, origin, and user
unlock state before executing OS actions. Storage is app-private by default;
the adapter never exposes arbitrary filesystem paths to an Ability.

This package is a host scaffold, not a signed Windows installer or Android
APK/AAB. Native implementations can be added behind this contract and tested
with the in-memory transport without changing an Ability package.
