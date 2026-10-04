export type Platform = "windows" | "android" | "linux" | "macos" | "ios" | "web";
export type PermissionDecision = "allow" | "deny" | "ask";

export interface AbilityManifest {
  schemaVersion: number;
  id: string;
  name: string;
  displayName: string;
  version: string;
  description?: string;
  author?: string;
  minCoreVersion?: string;
  platforms: Platform[];
  permissions?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  conflicts?: Record<string, string>;
  contributes?: Record<string, unknown[]>;
  entry: string;
  [key: string]: unknown;
}
export interface ModuleRecord { id: string; activeVersion: string | null; enabled: boolean; versions: Record<string, { manifest: AbilityManifest; packageHash?: string; packageRef?: string; [key: string]: unknown }>; history: string[]; [key: string]: unknown; }
export type UpdatePolicy = { mode: "automatic" | "manual" | "ignore" | "pinned"; version?: string };
export class PabError extends Error { code: string; details: Record<string, unknown>; constructor(code: string, message: string, details?: Record<string, unknown>); }
export const ErrorCode: Record<string, string>;
export function parseVersion(version: string): { major: number; minor: number; patch: number; prerelease: string[]; build: string[]; raw: string };
export function compareVersions(a: string | object, b: string | object): number;
export function normaliseVersion(version: string | object): string;
export function satisfies(version: string, range?: string): boolean;
export function canonicalRange(range?: string): string;
export const MANIFEST_SCHEMA_VERSION: number;
export const SUPPORTED_PLATFORMS: readonly Platform[];
export const KNOWN_PERMISSIONS: readonly string[];
export function validateManifest(manifest: unknown, options?: object): AbilityManifest;
export function assertManifestCompatible(manifest: AbilityManifest, options: { coreVersion?: string; platform?: Platform }): AbilityManifest;

export class EventBus {
  constructor(options?: object);
  subscribe(pattern: string, handler: (event: any) => unknown, options?: { once?: boolean; priority?: number }): () => void;
  on(pattern: string, handler: (event: any) => unknown, options?: object): () => void;
  publish(type: string, payload?: unknown, options?: object): Promise<{ event: any; results: unknown[]; errors: unknown[] }>;
  emit(type: string, payload?: unknown, options?: object): Promise<unknown>;
  waitFor(pattern: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any>;
  clear(): void;
  readonly size: number;
}
export class CommandBus {
  constructor(options?: object);
  register(definition: { id: string; title?: string; description?: string; handler: Function; abilityId?: string; permissions?: string[]; metadata?: object }): () => void;
  unregister(id: string): boolean;
  get(id: string): any;
  list(filter?: object): any[];
  execute(id: string, input?: unknown, options?: object): Promise<unknown>;
}
export class RequestBus {
  constructor(options?: object);
  register(definition: { id: string; title?: string; description?: string; handler: Function; abilityId?: string; permissions?: string[]; metadata?: object }): () => void;
  unregister(id: string): boolean;
  has(id: string): boolean;
  get(id: string): any;
  list(filter?: object): any[];
  request(id: string, payload?: unknown, options?: object): Promise<unknown>;
}
export class MemoryStorage {
  constructor(initial?: object);
  get<T = unknown>(key: string, fallback?: T): T | undefined | Promise<T | undefined>;
  set(key: string, value: unknown): void | Promise<void>;
  delete(key: string): boolean | Promise<boolean>;
  has(key: string): boolean | Promise<boolean>;
  keys(prefix?: string): string[] | Promise<string[]>;
  clear(prefix?: string): void | Promise<void>;
  entries(prefix?: string): [string, unknown][] | Promise<[string, unknown][]>;
}
export class NamespacedStorage extends MemoryStorage { constructor(storage: any, namespace: string); }
export class JsonStorage extends MemoryStorage { constructor(io: { read: Function; write: Function }); load(): Promise<void>; flush(): Promise<void>; }
export const StorageNamespace: Record<string, string>;

export class PermissionManager {
  constructor(options?: object);
  load(): Promise<void>;
  get(abilityId: string, permission: string): Promise<PermissionDecision>;
  list(abilityId: string): Promise<Record<string, PermissionDecision>>;
  set(abilityId: string, permission: string, decision: PermissionDecision): Promise<PermissionDecision>;
  request(abilityId: string, permissions: string[], context?: object): Promise<Record<string, PermissionDecision>>;
  assert(abilityId: string, permission: string, context?: object): Promise<true>;
  revoke(abilityId: string, permission?: string): Promise<void>;
}
export const PermissionDecision: Record<string, PermissionDecision>;

export class DependencyResolver {
  constructor(catalog?: unknown);
  setCatalog(catalog: unknown): this;
  resolve(requests: Record<string, string> | string[] | Map<string, string>, options?: object): { selected: Map<string, any>; order: any[]; optionalMissing: any[]; warnings: any[] };
}
export class ModuleStore {
  constructor(options?: object);
  load(): Promise<void>;
  list(): Promise<ModuleRecord[]>;
  get(id: string): Promise<ModuleRecord | undefined>;
  has(id: string): Promise<boolean>;
  getUpdatePolicy(id: string): Promise<UpdatePolicy>;
  setUpdatePolicy(id: string, policy: UpdatePolicy): Promise<UpdatePolicy>;
  installVersion(manifest: AbilityManifest, metadata?: object): Promise<ModuleRecord>;
  activate(id: string, version?: string): Promise<ModuleRecord>;
  enable(id: string): Promise<ModuleRecord>;
  disable(id: string): Promise<ModuleRecord>;
  removeVersion(id: string, version: string): Promise<ModuleRecord>;
  uninstall(id: string, options?: object): Promise<object>;
  repair(id: string, version?: string, metadata?: object): Promise<ModuleRecord>;
}
export class ContributionRegistry {
  add(abilityId: string, type: string, contribution: object): () => void;
  list(type: string, options?: object): any[];
  removeAbility(abilityId: string): void;
  clear(): void;
}
export class AbilityRuntime {
  constructor(options: object);
  activate(record: object, options?: object): Promise<object>;
  deactivate(abilityId: string): Promise<boolean>;
  deactivateAll(options?: { throwOnError?: boolean }): Promise<Array<{ id: string; error: unknown }>>;
  isActive(abilityId: string): boolean;
  getContext(abilityId: string): object | undefined;
}
export class ModuleManager {
  constructor(options: object);
  setCatalog(entries: unknown): void;
  install(input: unknown, options?: object): Promise<{ record: ModuleRecord; resolution: object }>;
  update(input: unknown, options?: object): Promise<object>;
  rollback(id: string, version?: string, options?: object): Promise<ModuleRecord>;
  disable(id: string): Promise<ModuleRecord>;
  enable(id: string, options?: object): Promise<ModuleRecord>;
  uninstall(id: string, options?: object): Promise<object>;
  getUpdatePolicy(id: string): Promise<UpdatePolicy>;
  setUpdatePolicy(id: string, policy: UpdatePolicy): Promise<UpdatePolicy>;
}
export class MemoryRepository {
  constructor(options?: object);
  load(): Promise<void>;
  write(entry: object): Promise<object>;
  get(id: string): Promise<object | undefined>;
  delete(id: string): Promise<boolean>;
  query(query?: object): Promise<object[]>;
  all(): Promise<object[]>;
  deleteBySource(source: string): Promise<number>;
}
export class SearchService {
  constructor(options?: object);
  search(query: string, options?: object): Promise<object[]>;
}
export interface Loadout { id: string; name: string; description: string; icon: string; abilityIds: string[]; visible: boolean; order: number; [key: string]: unknown; }
export class LoadoutManager {
  constructor(options?: object);
  load(): Promise<void>;
  list(): Promise<Loadout[]>;
  get(id: string): Promise<Loadout | undefined>;
  active(): Promise<Loadout | undefined>;
  create(input?: Partial<Loadout>): Promise<Loadout>;
  update(id: string, patch: Partial<Loadout>): Promise<Loadout>;
  activate(id: string): Promise<Loadout>;
  remove(id: string): Promise<void>;
}
export function sha256Hex(data: unknown): Promise<string>;
export function verifySha256(data: unknown, expected: string): Promise<boolean>;
export const CORE_VERSION: string;
export class PABCore {
  constructor(options?: object);
  readonly version: string;
  readonly platform: Platform;
  readonly eventBus: EventBus;
  readonly commands: CommandBus;
  readonly requests: RequestBus;
  readonly permissions: PermissionManager;
  readonly memory: MemoryRepository;
  readonly search: SearchService;
  readonly modules: ModuleManager;
  readonly runtime: AbilityRuntime;
  readonly loadouts: LoadoutManager;
  start(): Promise<this>;
  stop(): Promise<void>;
  request(name: string, payload?: unknown, options?: object): Promise<unknown>;
  installAbility(packageOrId: unknown, options?: object): Promise<object>;
  activateLoadout(id: string): Promise<Loadout>;
  refreshRegistry(source: unknown, options?: object): Promise<object>;
  getRegistry(options?: { allowStale?: boolean }): Promise<object | undefined>;
  getDashboardSnapshot(): Promise<object>;
  updateAbility(packageOrId: unknown, options?: object): Promise<object>;
  getAbilityUpdatePolicy(id: string): Promise<UpdatePolicy>;
  setAbilityUpdatePolicy(id: string, policy: UpdatePolicy): Promise<UpdatePolicy>;
  rollbackAbility(id: string, version?: string, options?: object): Promise<object>;
  repairAbility(id: string, options?: { version?: string; activate?: boolean; loader?: Function }): Promise<object>;
  resetAbility(id: string, options?: { removeData?: boolean; activate?: boolean; loader?: Function }): Promise<{ id: string; dataRemoved: boolean; dataPreserved: boolean }>;
  enableAbility(id: string, options?: object): Promise<object>;
  disableAbility(id: string): Promise<object>;
  uninstallAbility(id: string, options?: object | boolean): Promise<object>;
  exportAbilityData(id: string): Promise<object>;
  importAbilityData(id: string, snapshot: object, options?: { replace?: boolean }): Promise<object>;
  backup(options?: object): Promise<object>;
  restore(snapshot: object, options?: object): Promise<void>;
  diagnostics(): Promise<object>;
}
