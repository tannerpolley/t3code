#!/bin/bash
# Installs the fork APK on the owner's Pixel 9 over USB adb. Usage: install-apk.sh [apk] (default: latest build)
set -euo pipefail
SERIAL=49191FDAQ001KZ
apk="${1:-$HOME/.local/opt/t3-code/android/latest.apk}"
adb="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb"
[ -f "$apk" ] || { echo "No APK at $apk. Run scripts/fork-android/build-apk.sh first."; exit 1; }
state=$("$adb" -s "$SERIAL" get-state 2>/dev/null || true)
if [ "$state" != device ]; then
  echo "The Pixel ($SERIAL) is not connected${state:+ (state: $state)}. Plug it in over USB, unlock it, and allow USB debugging."
  exit 2
fi
"$adb" -s "$SERIAL" install -r "$(readlink -f "$apk")"
