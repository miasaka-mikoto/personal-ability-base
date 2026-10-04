# Ability Store security boundary

The implementation lives in `packages/registry-security`. Core should treat it
as the only boundary between a Registry/GitHub release and the Ability Runtime.

```text
Registry source → validate + cache → resolve metadata
                                   ↓
                         download (size limit)
                                   ↓
                      SHA-256 + pinned signature
                                   ↓
                     permission/trust confirmation
                                   ↓
                     safe staging extraction
                                   ↓
             manifest/schema/permission parity checks
                                   ↓
               versioned module store + migration hook
                                   ↓
                         register / activate
```

## Required host decisions

1. Pin official Ed25519 public keys in Core. Do not trust a key solely because
   it arrived in an unsigned remote registry document.
2. Show `AbilityRegistryEntry.permissions` before calling `install()` and pass
   the user's explicit approvals. An omitted approval is a denial.
3. Supply a Core-owned `MigrationRunner`. The package intentionally does not
   execute downloaded migration JavaScript directly.
4. Use a platform-specific loader after installation; this package only
   verifies, extracts and records module code.
5. Persist `RegistryCacheStore` and `PackageCache` in private Core storage, not
   inside an Ability's user-data directory.
6. Persist update policy with the module state. `automatic`/`manual` mode,
   ignored versions, and pinned versions are policy controls—not module data—so
   they survive registry refreshes and are intentionally bypassed only by an
   explicit `force` update.

## Failure mapping

Map `PabRegistryError.code` to actionable UI states:

| Code | User-facing state |
| --- | --- |
| `DOWNLOAD_FAILED` | Download failed; retry or use cached package |
| `HASH_MISMATCH` | Package corrupted or registry mismatch |
| `SIGNATURE_INVALID` | Signature invalid; do not install |
| `TRUST_BLOCKED` | Source requires explicit trust approval |
| `DEPENDENCY_MISSING` / `DEPENDENCY_CONFLICT` / `DEPENDENCY_CYCLE` | Dependency resolution failed |
| `PLATFORM_UNSUPPORTED` | Ability does not support this device |
| `CORE_VERSION_UNSUPPORTED` | Update Core before installing |
| `PERMISSION_DENIED` | Ask user to review requested permissions |
| `INVALID_MANIFEST` / `ARCHIVE_INVALID` / `PATH_TRAVERSAL` | Package rejected as unsafe |
| `MIGRATION_FAILED` | Keep old version active; offer rollback |

Never collapse these into `Unknown Error`.
