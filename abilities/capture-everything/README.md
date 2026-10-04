# Capture Everything / 随手捕获

`Capture Everything` is the official PAB quick-capture Ability. It provides a
single portable entry point for a Windows global hotkey, Android Share Target,
Quick Tile, launcher shortcut, or a host-published `capture.created` event.

## Commands

- `capture-everything.capture` — save a thought, URL, shared text, or a
  clipboard payload.
- `capture-everything.quick-capture` — alias intended for native hotkeys and
  Android Share Targets.
- `capture-everything.list` — query the local capture inbox with `text`,
  `tags`, `channel`, `status`, and `limit` filters.

Every capture is stored in the Ability's private `captures` namespace and is
also written through the controlled `memory.write()` API. The Ability publishes
`capture.created` with a stable `captureId` and `memoryId`, so downstream
Abilities can react without reading another Ability's storage directly.

## Runtime-neutral input

```js
await pab.commands.execute("capture-everything.capture", {
  text: "Try a 20-minute Japanese speaking drill tomorrow.",
  tags: ["japanese", "next"],
  channel: "quick"
});

await pab.commands.execute("capture-everything.quick-capture", {
  text: "https://example.com/article",
  title: "Read later",
  channel: "share",
  tags: ["reading"]
});
```

Native adapters should pass Share Target or clipboard text as the command
payload. A host that owns the clipboard bridge may pass `{ fromClipboard: true
}`; the Ability then requests the controlled `clipboard.read` operation rather
than touching the filesystem or platform APIs directly.

## Event input

```js
await eventBus.publish("capture.created", {
  text: "Captured from an Android share sheet",
  channel: "share",
  tags: ["android"]
});
```

External events are normalised into the same inbox and memory contract. Events
emitted by this Ability carry `memoryWritten: true` and are ignored by its own
listener, preventing a capture loop. Disable or uninstall preserves captures
by default because all state is namespaced under the Core-owned user-data root.

## Permissions

`storage.private`, `memory.read`, `memory.write`, `clipboard`, and
`notifications` are explicit in `manifest.json`. Clipboard access is only
requested when a host asks for `fromClipboard`; ordinary text/share captures
do not touch the clipboard.
