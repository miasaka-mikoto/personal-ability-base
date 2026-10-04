# PAB security model (v0.1)

## Trust

Registry entries declare one of `official`, `verified`, `community`, `local`,
or `developer`. Official and Verified packages require a pinned Ed25519 key by
default. Community/Local/Developer packages remain visible only after an
explicit advanced trust choice.

## Package verification

The installer performs the following in order:

1. Resolve platform, Core version, dependencies, and conflicts from metadata.
2. Download through a size-limited adapter (GitHub Releases is the production
   adapter; tests use an in-memory adapter).
3. Verify SHA-256 and detached signature before extraction.
4. Reject encrypted ZIP entries, symlinks, CRC failures, and traversal paths.
5. Validate `manifest.json`, entry path, ID, and version.
6. Extract to a unique staging directory, then atomically move it to
   `modules/<id>/<version>`.

## Data safety

Module code and user data have separate roots. A migration is an explicit host
callback and failures abort the install. Previous module versions remain
available for rollback. Uninstall removes code/state by default but retains
`userdata/abilities/<id>` unless the user explicitly chooses “remove module and
data”.

## Known v0.1 limitations

- The repository includes a portable runtime contract, not a completed signed
  Windows installer or Android APK.
- A production shell must place untrusted JavaScript in a Worker/WebView
  sandbox and provide native APIs through an allow-listed bridge.
- Signature public keys are deployment configuration; the sample registry uses
  placeholders and must be replaced before publishing official releases.
