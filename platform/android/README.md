# Android shell scaffold

This directory defines the Android host contract without pretending that a
release APK/AAB already exists.

- `bridge-contract.json` is the versioned, platform-neutral bridge surface.
- `verify-shell.mjs` validates that contract with Node's standard library.
- `build-shell.sh` is an offline verification entry point and a placeholder
  for a future Gradle/Capacitor build lane.

Run the safe contract check from the repository root:

```sh
sh platform/android/build-shell.sh
```

To request a future native build explicitly, set
`PAB_ANDROID_BUILD_MODE=native`. In the current repository that mode exits with
a clear “native artifact not built” message because no Android project,
keystore, or signed APK/AAB is checked in. This is intentional: downloading a
random binary or embedding signing credentials would violate the PAB supply
chain boundary.

The eventual Android host may use WebView/Capacitor and map Share Target,
Quick Tile, widgets, shortcuts, and notification actions to the same commands
and events. Ability modules remain JavaScript/JSON/HTML packages; they do not
ship arbitrary Kotlin/Java binaries.
