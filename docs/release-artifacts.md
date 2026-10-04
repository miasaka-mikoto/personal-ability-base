# Release artifacts

PAB source releases are produced without npm dependencies or a platform zip
utility. The canonical command is:

```bash
node scripts/package-source.mjs
```

It creates:

```text
artifacts/PersonalAbilityBase-v<package-version>-source.zip
artifacts/PersonalAbilityBase-v<package-version>-source.zip.sha256
```

The output path and version can be overridden for CI or a release staging
directory:

```bash
node scripts/package-source.mjs \
  --version 0.2.0 \
  --output /tmp/pab-release/PersonalAbilityBase-v0.2.0-source.zip
```

The archive writer is implemented using Node.js built-ins. It writes sorted
UTF-8 paths, fixed ZIP timestamps, normalized permissions, and uncompressed
(`store`) entries. That makes the bytes reproducible across Windows, Android
build hosts, and Unix when the source tree is identical. The adjacent checksum
uses the conventional `sha256sum` format and can be checked with:

```bash
sha256sum -c artifacts/PersonalAbilityBase-v<package-version>-source.zip.sha256
```

The same check works on Windows or any host with Node.js, without requiring a
`sha256sum` executable:

```bash
node scripts/package-source.mjs \
  --verify artifacts/PersonalAbilityBase-v<package-version>-source.zip
```

## Boundary

The source artifact contains the Core, SDK, registry contracts, official
Abilities, dashboard source, schemas, templates, tests, scripts, and docs. It
does not contain runtime state or build-machine material:

- archives and generated checksum sidecars (`.zip`, `.tar`, `.tgz`, `.gz`,
  `.xz`, `.7z`, `.rar`, `.pab`, `.sha256`, `.sha512`);
- `.git`, `.hg`, `.svn`, workspace metadata (`.agents`, `.aws`, `.codex`),
  `node_modules`, `coverage`, and generated caches;
- `userdata`, `demo-data`, and `.env*` files;
- private-key and keystore material (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`) and
  credential config files (`.npmrc`, `.netrc`, `.pypirc`);
- unrelated generated `dist/` trees (official `abilities/**/dist/` is retained
  because those entry files are installable module artifacts);
- symlinks (to prevent a release from escaping the repository boundary).

The output directory `artifacts/` is also excluded, so rebuilding a release
cannot accidentally package an older release or its checksum. A dry run lists
the exact included paths without writing anything:

```bash
node scripts/package-source.mjs --dry-run
```

This source archive is not a signed installer, APK/AAB, or Windows executable.
Those platform artifacts require their respective signing keys and build
toolchains; their provenance and signatures must be recorded separately in a
release manifest.
