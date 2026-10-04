export type HostPlatform = "windows" | "android" | "linux" | "macos" | "ios" | "unknown";
export type HostKind = "webview2" | "tauri" | "android-webview" | "capacitor" | "generic";
export type HostCapability = "globalHotkey" | "quickTile" | "shareTarget" | "notifications" | "persistentStorage";

export interface HostTransport {
  kind?: HostKind | string;
  invoke?: (method: string, payload?: unknown) => unknown | Promise<unknown>;
  call?: (method: string, payload?: unknown) => unknown | Promise<unknown>;
  onMessage?: (handler: (message: unknown) => unknown) => (() => void) | void;
}

export interface HostStorage {
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  entries(prefix?: string): Promise<Array<[string, unknown]>>;
  clear(prefix?: string): Promise<void>;
}

export interface HostActionDefinition {
  id: string;
  title?: string;
  description?: string;
  commandId?: string;
  handler?: (payload: unknown, context: { source: string; host: HostAdapter; definition: HostActionDefinition; metadata: Record<string, unknown> }) => unknown | Promise<unknown>;
  binding?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface HostAdapterOptions {
  platform?: HostPlatform;
  kind?: HostKind | string;
  bridge?: HostTransport;
  transport?: HostTransport;
  core?: any;
  commandExecutor?: (commandId: string, input?: unknown, options?: Record<string, unknown>) => unknown | Promise<unknown>;
  storage?: HostStorage;
  fallbackStorage?: HostStorage;
  storageNamespace?: string;
  capabilities?: Partial<Record<HostCapability, boolean>>;
  logger?: { error?: Function; warn?: Function; info?: Function };
  [key: string]: unknown;
}

export const HostMethod: Readonly<Record<string, string>>;
export const HostEvent: Readonly<Record<string, string>>;
export const HostCapability: Readonly<Record<string, HostCapability>>;

export class HostAdapterError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

export class MemoryHostStorage implements HostStorage {
  constructor(initial?: Record<string, unknown>);
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  entries(prefix?: string): Promise<Array<[string, unknown]>>;
  clear(prefix?: string): Promise<void>;
}

export class NamespacedHostStorage implements HostStorage {
  constructor(storage: HostStorage, namespace: string);
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, unknown]>>;
  clear(): Promise<void>;
}

export class BridgeHostStorage implements HostStorage {
  constructor(transport?: HostTransport, options?: { fallback?: HostStorage; namespace?: string });
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  entries(prefix?: string): Promise<Array<[string, unknown]>>;
  clear(prefix?: string): Promise<void>;
}

export class WebStorageAdapter implements HostStorage {
  constructor(storage?: Storage, options?: { prefix?: string; fallback?: HostStorage });
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  entries(prefix?: string): Promise<Array<[string, unknown]>>;
  clear(prefix?: string): Promise<void>;
}

export class HostAdapter {
  readonly platform: HostPlatform;
  readonly kind: HostKind | string;
  readonly capabilities: Record<HostCapability, boolean>;
  readonly storage: HostStorage;
  started: boolean;
  constructor(options?: HostAdapterOptions);
  supports(capability: HostCapability): boolean;
  getCapabilities(): Record<HostCapability, boolean>;
  on(event: string, handler: (event: any) => unknown): () => void;
  emit(event: string, payload?: unknown): Promise<any>;
  start(): Promise<this>;
  stop(): Promise<void>;
  invoke(method: string, payload?: unknown): Promise<unknown>;
  registerGlobalHotkey(definition: HostActionDefinition): Promise<() => Promise<boolean>>;
  registerQuickTile(definition: HostActionDefinition): Promise<() => Promise<boolean>>;
  registerShareTarget(definition: HostActionDefinition): Promise<() => Promise<boolean>>;
  executeCommand(commandId: string, input?: unknown, options?: Record<string, unknown>): Promise<unknown>;
  dispatchGlobalHotkey(bindingOrId: string, payload?: unknown): Promise<unknown>;
  triggerQuickTile(id: string, payload?: unknown): Promise<unknown>;
  receiveShare(payload: unknown, targetId?: string): Promise<unknown>;
  showNotification(notification: Record<string, unknown>): Promise<Record<string, unknown>>;
  dismissNotification(id: string): Promise<unknown>;
  handleHostMessage(message: unknown): Promise<unknown>;
}

export class WindowsHostAdapter extends HostAdapter { constructor(options?: HostAdapterOptions); }
export class AndroidHostAdapter extends HostAdapter { constructor(options?: HostAdapterOptions); }
export class WindowsWebView2Adapter extends WindowsHostAdapter { constructor(options?: HostAdapterOptions); }
export class WindowsTauriAdapter extends WindowsHostAdapter { constructor(options?: HostAdapterOptions); }
export class AndroidWebViewAdapter extends AndroidHostAdapter { constructor(options?: HostAdapterOptions); }
export class AndroidCapacitorAdapter extends AndroidHostAdapter { constructor(options?: HostAdapterOptions); }

export function createWebView2Transport(webview?: any): HostTransport;
export function createTauriTransport(tauri?: any): HostTransport;
export function createAndroidWebViewTransport(android?: any, windowObject?: any): HostTransport;
export function createCapacitorTransport(capacitor?: any, options?: Record<string, unknown>): HostTransport;
export function createWindowsWebView2Adapter(options?: HostAdapterOptions): WindowsWebView2Adapter;
export function createWindowsTauriAdapter(options?: HostAdapterOptions): WindowsTauriAdapter;
export function createAndroidWebViewAdapter(options?: HostAdapterOptions): AndroidWebViewAdapter;
export function createAndroidCapacitorAdapter(options?: HostAdapterOptions): AndroidCapacitorAdapter;
export function createHostAdapter(options?: HostAdapterOptions): HostAdapter;
export function detectPlatform(): HostPlatform;
export function detectHostKind(platform?: HostPlatform): HostKind | string;
