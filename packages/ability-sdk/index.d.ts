export type Platform = "windows" | "android" | "linux" | "macos" | "ios" | "web";
export type Permission = "storage.private" | "storage.shared" | "memory.read" | "memory.write" | "camera" | "microphone" | "location" | "network" | "clipboard" | "notifications" | "filesystem.import" | "filesystem.export" | `custom.${string}`;
export type ContributionKind = "pages" | "commands" | "cards" | "searchProviders" | "workflows" | "settings";
export type MaybePromise<T> = T | Promise<T>;

export interface AbilityManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  minCoreVersion: string;
  platforms: Platform[];
  permissions: Permission[];
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  conflicts?: Record<string, string>;
  contributes: Partial<Record<ContributionKind, unknown[]>>;
  entry: string;
  runtime?: { type?: string; apiVersion?: number };
  icon?: string;
  source?: { kind?: string; repository?: string; releaseUrl?: string };
  integrity?: { sha256?: string; signature?: string; keyId?: string };
  signature?: { algorithm: string; keyId: string; value: string; signedPayload?: "package" | "sha256" };
  migrations?: Array<{ from: string; to: string; entry: string }>;
  releaseNotes?: string;
  [key: string]: unknown;
}

export interface RuntimeAdapter {
  version?: string;
  subscribeEvent(event: string, handler: (payload: unknown, envelope?: EventEnvelope) => void): (() => void) | void;
  publishEvent(event: string, payload?: unknown, sourceAbilityId?: string): MaybePromise<unknown>;
  request?(name: string, payload?: unknown, sourceAbilityId?: string): MaybePromise<unknown>;
  openPage(pageId: string, params?: unknown, sourceAbilityId?: string): MaybePromise<unknown>;
  showNotification(notification: Notification): MaybePromise<unknown>;
  registerRequest?(definition: RequestContribution & { abilityId?: string }): () => void;
  storageGet(abilityId: string, key: string, fallback?: unknown): MaybePromise<unknown>;
  storageSet(abilityId: string, key: string, value: unknown): MaybePromise<unknown>;
  storageDelete(abilityId: string, key: string): MaybePromise<unknown>;
  storageKeys?(abilityId: string): MaybePromise<string[]>;
  sharedStorageGet?(key: string, fallback?: unknown): MaybePromise<unknown>;
  sharedStorageSet?(key: string, value: unknown): MaybePromise<unknown>;
  memoryQuery(query: MemoryQuery, sourceAbilityId?: string): MaybePromise<unknown>;
  memoryWrite(entry: MemoryEntry, sourceAbilityId?: string): MaybePromise<unknown>;
  requestPermission?(permission: Permission, reason?: string, sourceAbilityId?: string): MaybePromise<boolean | Record<string, string>>;
  getSettings(abilityId: string): MaybePromise<unknown>;
  setSettings(abilityId: string, value: unknown): MaybePromise<unknown>;
  log?(level: string, message: string, metadata?: Record<string, unknown>): MaybePromise<unknown>;
}

export interface EventEnvelope { id: string; event: string; timestamp: string; sourceAbilityId?: string; payload?: unknown; }
export interface MemoryQuery { text?: string; tags?: string[]; limit?: number; since?: string; until?: string; [key: string]: unknown; }
export interface MemoryEntry { id?: string; text: string; tags?: string[]; source?: string; createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown>; [key: string]: unknown; }
export interface Notification { title: string; body?: string; level?: "info" | "success" | "warning" | "error"; action?: { label: string; command: string }; [key: string]: unknown; }
export interface Contribution { id?: string; title?: string; [key: string]: unknown; }
export interface CommandContribution extends Contribution { description?: string; execute?: (input?: unknown, context?: unknown) => unknown | Promise<unknown>; handler?: (input?: unknown, context?: unknown) => unknown | Promise<unknown>; keybinding?: string; }
export interface RequestContribution extends Contribution { description?: string; permissions?: Permission[]; execute?: (input?: unknown, context?: unknown) => unknown | Promise<unknown>; handler?: (input?: unknown, context?: unknown) => unknown | Promise<unknown>; }
export interface PageContribution extends Contribution { route?: string; render?: (...args: unknown[]) => unknown; }
export interface CardContribution extends Contribution { render?: (...args: unknown[]) => unknown; refresh?: (...args: unknown[]) => unknown | Promise<unknown>; }
export interface AbilityContext {
  readonly manifest: AbilityManifest;
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  registerPage(value: PageContribution): string | undefined;
  registerCard(value: CardContribution): string | undefined;
  registerCommand(value: CommandContribution): string | undefined;
  registerRequest(value: RequestContribution): string | undefined;
  registerSearchProvider(value: Contribution): string | undefined;
  registerWorkflow(value: Contribution): string | undefined;
  registerSetting(value: Contribution): string | undefined;
  getContributions(): Record<ContributionKind, Contribution[]>;
  subscribeEvent(event: string, handler: (payload: unknown, envelope?: EventEnvelope) => void): () => void;
  publishEvent(event: string, payload?: unknown): MaybePromise<unknown>;
  request(name: string, payload?: unknown): MaybePromise<unknown>;
  openPage(pageId: string, params?: unknown): MaybePromise<unknown>;
  showNotification(notification: Notification): MaybePromise<unknown>;
  storage: { get<T = unknown>(key: string, fallback?: T): MaybePromise<T | undefined>; set(key: string, value: unknown): MaybePromise<unknown>; delete(key: string): MaybePromise<unknown>; keys(): MaybePromise<string[]> };
  sharedStorage: { get<T = unknown>(key: string, fallback?: T): MaybePromise<T | undefined>; set(key: string, value: unknown): MaybePromise<unknown> };
  memory: { query(query: MemoryQuery): MaybePromise<unknown>; write(entry: MemoryEntry): MaybePromise<unknown> };
  requestPermission(permission: Permission, reason?: string): Promise<boolean>;
  getSettings<T = Record<string, unknown>>(): MaybePromise<T>;
  setSettings(value: unknown): MaybePromise<unknown>;
  log(level: string, message: string, metadata?: Record<string, unknown>): MaybePromise<unknown>;
  dispose(): void;
}

export interface AbilityDefinition { activate(api: AbilityContext): unknown | Promise<unknown>; deactivate?(api: AbilityContext): unknown | Promise<unknown>; onUpdate?(api: AbilityContext, updateInfo: unknown, nextManifest: AbilityManifest): unknown | Promise<unknown>; }
export interface AbilityHandle { manifest: AbilityManifest; api: AbilityContext; active: boolean; activate(): Promise<unknown>; deactivate(): Promise<void>; update(nextManifest: AbilityManifest, updateInfo?: unknown): Promise<AbilityManifest>; }
export function defineAbility(definition: AbilityDefinition): Readonly<AbilityDefinition & ((api: AbilityContext) => unknown | Promise<unknown>)>;
export function createAbilityContext(runtime: RuntimeAdapter, manifest: AbilityManifest, options?: { grantedPermissions?: Permission[] }): AbilityContext;
export function registerAbility(runtime: RuntimeAdapter, manifest: AbilityManifest, definition: AbilityDefinition | ((api: AbilityContext) => unknown | Promise<unknown>) | { default: AbilityDefinition }, options?: { grantedPermissions?: Permission[] }): Promise<AbilityHandle>;
export function validateManifest(input: unknown, options?: unknown): { valid: boolean; errors: Array<{ path: string; code: string; message: string }>; manifest: AbilityManifest };
export function assertValidManifest(input: unknown, options?: unknown): AbilityManifest;
export function createManifest(overrides?: Partial<AbilityManifest>): AbilityManifest;
export const MANIFEST_SCHEMA_VERSION: 1;
export const PLATFORMS: readonly Platform[];
export const PERMISSIONS: readonly Permission[];
export { EVENTS } from "./events.js";
