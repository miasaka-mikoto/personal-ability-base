#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
MODE=${PAB_ANDROID_BUILD_MODE:-verify}

case "$MODE" in
  verify)
    exec node "$ROOT_DIR/platform/android/verify-shell.mjs"
    ;;
  native)
    echo "Android native artifact not built: Gradle project and signing configuration are not checked in yet." >&2
    echo "This scaffold only defines the bridge contract; no APK/AAB has been generated." >&2
    exit 2
    ;;
  *)
    echo "Unsupported PAB_ANDROID_BUILD_MODE=$MODE (use verify or native)." >&2
    exit 64
    ;;
esac
