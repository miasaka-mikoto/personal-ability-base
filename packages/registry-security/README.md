# PAB Registry & Ability Store Security

This package is the Core-side implementation of the Personal Ability Base
distribution boundary. It keeps the registry and package cache offline-first,
verifies every package before extraction, resolves dependencies from metadata,
and stores module code by immutable version while keeping user data elsewhere.

## Security properties

- Registry JSON is schema-validated before it is cached or displayed.
- Registry and package caches are content-addressed/atomically written. A
  stale registry can be used while offline and is explicitly marked `stale`.
- Package downloads are size-limited and can be supplied by any downloader;
  `FetchPackageDownloader` is the production HTTP adapter and
  `MemoryPackageDownloader` is useful for tests.
- SHA-256 must match the registry entry before a package is extracted.
- Official and Verified sources require an Ed25519 detached signature from a
  trusted Core key. Community/Local/Developer sources are blocked by the
  default policy and require an explicit user-facing trust choice.
- ZIP extraction supports stored/deflate entries and rejects encrypted files,
  symlinks, malformed CRCs, and path traversal. The extractor never writes
  outside its staging directory.
- Dependencies use semantic-version constraints, detect cycles, conflicts and
  missing platforms, and return a dependency-first install order.
- Modules install under `modules/<id>/<version>/`; state is in `state/`; user
  data is in `userdata/abilities/<id>/`. Uninstall preserves user data unless
  `removeData: true` is explicitly supplied. Reinstall reports retained data
  through an actionable warning so Core can offer a `[RESTORE]` step.
- Install/update is serialized per ability. Previous versions remain available
  for rollback and all state writes are atomic.

## Core integration

```ts
import {
  AbilityInstaller, ModuleStore, FetchPackageDownloader, TrustPolicy,
  RegistryCacheStore, HttpRegistrySource,
} from "@personal-ability-base/registry-security";

const cache = new RegistryCacheStore(corePaths.registryCache);
const registry = await cache.refresh(new HttpRegistrySource(REGISTRY_URL), {
  allowStaleOnError: true,
});

const installer = new AbilityInstaller({
  store: new ModuleStore({
    root: corePaths.moduleStore,
    userDataRoot: corePaths.userData,
    // Supply a Core-owned migration runner; downloaded module code is never
    // executed as a migration by this package.
  }),
  downloader: new FetchPackageDownloader(),
  trustPolicy: new TrustPolicy({ trustedKeys: registry.document.publicKeys }),
  onProgress: (progress) => eventBus.publish("ability.install.progress", progress),
});

await installer.install(entry, {
  platform: "windows",
  coreVersion: core.version,
  approvedPermissions: permissionManager.approved(entry.id),
});
```

`AbilityInstallCoordinator` combines `DependencyResolver` and
`AbilityInstaller` for an `INSTALL PACK` action. A UI should render each
`InstallProgress.stage` and map `PabRegistryError.code` to actionable text;
never collapse these errors into `Unknown Error`.

For a complete Store surface, `GitHubAbilityStore` wires a cache, a GitHub/raw
`RegistrySource`, the installer and a `ModuleStore`:

```ts
const store = new GitHubAbilityStore({
  cache: new RegistryCacheStore(paths.registry),
  source: new GitHubRegistrySource("PersonalAbilityBase", "Registry"),
  installer,
  moduleStore,
  platform: "windows",
  coreVersion: "0.1.0",
});

await store.refresh({ allowStaleOnError: true });
const matches = await store.find("decision");
await store.installPack("researcher-pack", {
  platform: "windows",
  coreVersion: "0.1.0",
  approvedPermissions: [],
});
```

`GitHubAbilityStore` also exposes `list`, `install`, `update`, `enable`,
`disable`, `rollback`, `uninstall` and `listInstalled`. Update policy is
persisted per ability: choose `automatic` or `manual`, pin a version, ignore a
version, or pass `force: true` for an explicit override. Automatic triggers
respect manual mode; manual triggers always run. It does not require a
GitHub account or SDK; the injected source/downloader can be replaced with a
local/offline implementation.

## Registry shape

See `fixtures/registry.json`. Each version is a separate entry so an update or
rollback always has a deterministic package URL and digest. A package must have
`manifest.json` at its archive root; its `id`, `version`, `schemaVersion` and
`entry` are checked against the registry before activation.

## Tests

No network or third-party package is needed:

```sh
npm test --workspace packages/registry-security
# or, from this directory:
node --experimental-strip-types tests/registry-security.test.ts
```

The source is TypeScript and intentionally has no third-party runtime
dependency. Core can bundle it with its normal TypeScript toolchain; the
included test command uses Node 24's built-in type stripping for a zero-install
verification path.
