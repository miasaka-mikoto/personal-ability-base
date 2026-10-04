import test from "node:test";
import assert from "node:assert/strict";
import {
  AndroidCapacitorAdapter,
  HostAdapterError,
  HostEvent,
  MemoryHostStorage,
  NamespacedHostStorage,
  WindowsWebView2Adapter,
  createAndroidWebViewTransport,
  createWebView2Transport,
} from "../src/index.js";

class FakeTransport {
  constructor() { this.calls = []; this.listeners = new Set(); }
  async invoke(method, payload) { this.calls.push({ method, payload }); return { ok: true }; }
  onMessage(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  push(message) { for (const listener of this.listeners) listener(message); }
}

test("Windows adapter registers and routes a global hotkey to Core command", async () => {
  const transport = new FakeTransport();
  const calls = [];
  const host = new WindowsWebView2Adapter({ bridge: transport, commandExecutor: async (id, input) => { calls.push({ id, input }); return "captured"; } });
  const events = [];
  host.on(HostEvent.HOTKEY, (event) => events.push(event.payload));
  await host.start();
  const dispose = await host.registerGlobalHotkey({ id: "capture", binding: "Ctrl+Shift+Space", commandId: "capture.now" });
  transport.push({ type: "host.hotkey", id: "capture", payload: { text: "hello" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "capture.now", input: { text: "hello" } }]);
  assert.equal(events[0].id, "capture");
  assert.ok(transport.calls.some((call) => call.method === "globalHotkey.register"));
  await dispose();
  assert.ok(transport.calls.some((call) => call.method === "globalHotkey.unregister"));
  await host.stop();
});

test("Android adapter exposes Quick Tile and Share Target through one API", async () => {
  const transport = new FakeTransport();
  const routed = [];
  const host = new AndroidCapacitorAdapter({ bridge: transport, commandExecutor: async (id, payload) => { routed.push({ id, payload }); return id; } });
  await host.start();
  await host.registerQuickTile({ id: "capture-tile", commandId: "capture.now" });
  await host.registerShareTarget({ id: "capture-share", commandId: "capture.ingest" });
  transport.push({ type: "host.quickTile", id: "capture-tile", payload: { source: "tile" } });
  transport.push({ type: "host.share", id: "capture-share", payload: { text: "shared" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(routed, [
    { id: "capture.now", payload: { source: "tile" } },
    { id: "capture.ingest", payload: { text: "shared" } },
  ]);
  assert.ok(transport.calls.some((call) => call.method === "quickTile.register"));
  assert.ok(transport.calls.some((call) => call.method === "shareTarget.register"));
});

test("unsupported capability fails explicitly instead of silently doing nothing", async () => {
  const host = new AndroidCapacitorAdapter({ bridge: new FakeTransport() });
  await assert.rejects(() => host.registerGlobalHotkey({ id: "x", commandId: "x" }), (error) => error instanceof HostAdapterError && error.code === "CAPABILITY_UNAVAILABLE");
});

test("local handler functions survive definition normalisation", async () => {
  const transport = new FakeTransport();
  const host = new WindowsWebView2Adapter({ bridge: transport });
  await host.start();
  const received = [];
  await host.registerGlobalHotkey({
    id: "local-handler",
    binding: "Ctrl+Alt+L",
    handler: (payload) => { received.push(payload); return "handled"; },
  });
  const result = await host.dispatchGlobalHotkey("local-handler", { value: 42 });
  assert.equal(result, "handled");
  assert.deepEqual(received, [{ value: 42 }]);
});

test("host storage namespaces keys and keeps an offline fallback", async () => {
  const root = new MemoryHostStorage();
  const storage = new NamespacedHostStorage(root, "abilities/com.pab.capture");
  await storage.set("draft", { text: "hello" });
  assert.deepEqual(await storage.get("draft"), { text: "hello" });
  assert.deepEqual(await storage.keys(), ["draft"]);
  assert.deepEqual(await root.keys(), ["abilities/com.pab.capture/draft"]);
  await storage.clear();
  assert.equal(await storage.get("draft"), undefined);
});

test("WebView2 transport sends a serialisable request and receives messages", async () => {
  const posted = [];
  const listeners = new Set();
  const webview = {
    postMessage(message) { posted.push(message); },
    addEventListener(type, handler) { if (type === "message") listeners.add(handler); },
    removeEventListener(type, handler) { if (type === "message") listeners.delete(handler); },
  };
  const transport = createWebView2Transport(webview);
  const received = [];
  const dispose = transport.onMessage((message) => received.push(message));
  const result = transport.invoke("notifications.show", { title: "Ready" });
  assert.equal(result.dispatched, true);
  assert.equal(posted[0].type, "pab.host.request");
  for (const listener of listeners) listener({ data: { type: "host.response", payload: { ok: true } } });
  assert.deepEqual(received[0], { type: "host.response", payload: { ok: true } });
  dispose();
});

test("Android WebView transport serialises messages for a JavaScript interface", () => {
  const messages = [];
  const transport = createAndroidWebViewTransport({ postMessage: (message) => messages.push(JSON.parse(message)) }, {});
  const result = transport.invoke("quickTile.register", { id: "capture" });
  assert.equal(result.dispatched, true);
  assert.equal(messages[0].type, "pab.host.request");
  assert.equal(messages[0].method, "quickTile.register");
});
