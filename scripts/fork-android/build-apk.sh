#!/bin/bash
# Builds the fork's release Android APK on this PC: no EAS, no Play Store. Idempotent per commit.
# Usage: scripts/fork-android/build-apk.sh [commit]   (default: origin/main)
# Output: ~/.local/opt/t3-code/android/t3code-fork-<sha>.apk, plus latest.apk pointing at it.
set -euo pipefail
REPO="$HOME/Workspaces/Applications/t3code"
BUILD="$REPO/.worktrees/android-build"
OUT="$HOME/.local/opt/t3-code/android"
KEYSTORE="$HOME/.local/share/t3-android/fork-release.p12"
# Own applicationId: installs beside upstream's com.t3tools.t3code instead of replacing it.
PACKAGE=com.tannerpolley.t3code
APP_NAME="T3 Code Fork"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$HOME/.local/share/vite-plus/fallback-bin:$PATH"
build_tools="$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"

git -C "$REPO" fetch -q origin
sha=$(git -C "$REPO" rev-parse --verify "${1:-origin/main}^{commit}")
apk="$OUT/t3code-fork-${sha:0:10}.apk"
mkdir -p "$OUT"
if [ -f "$apk" ]; then
  ln -sfn "$(basename "$apk")" "$OUT/latest.apk"
  echo "# Already built: $apk"; exit 0
fi

echo "# Checking out ${sha:0:10} in $BUILD"
if [ -d "$BUILD" ]; then git -C "$BUILD" checkout -q --detach -f "$sha"; else git -C "$REPO" worktree add -q --detach "$BUILD" "$sha"; fi
cd "$BUILD"
echo "# Installing dependencies"
CI=true T3CODE_PROJECT_ROOT="$REPO" nice -n 10 node scripts/setup-worktree.ts

echo "# Generating the native project"
cd apps/mobile
# Updates off: upstream's EAS update channel would otherwise swap in upstream's JS bundle.
export APP_VARIANT=production T3CODE_MOBILE_UPDATES_ENABLED=0 EXPO_NO_GIT_STATUS=1 NODE_OPTIONS=--max-old-space-size=3072
pnpm exec expo prebuild --clean --platform android --no-install
gradle_file=android/app/build.gradle strings=android/app/src/main/res/values/strings.xml
sed -i -E "s/applicationId '[^']+'/applicationId '$PACKAGE'/; s/versionCode [0-9]+/versionCode $(git rev-list --count "$sha")/" "$gradle_file"
sed -i -E "s|<string name=\"app_name\">[^<]*</string>|<string name=\"app_name\">$APP_NAME</string>|" "$strings"
grep -q "applicationId '$PACKAGE'" "$gradle_file" && grep -q ">$APP_NAME<" "$strings" || { echo "Prebuild output changed; the applicationId or app name patch did not apply."; exit 1; }

echo "# Building (capped at 8 cores and 8 GB)"
cd android
# taskset caps the cores ninja and Gradle see; the scope caps memory. --no-daemon leaves nothing running.
gradle() {
  systemd-run --user --scope --quiet -p MemoryHigh=7G -p MemoryMax=8G \
    taskset -c 0-7 nice -n 10 ./gradlew "$@" -x lintVitalAnalyzeRelease -x lintVitalRelease \
    --no-daemon --max-workers=8 -PreactNativeArchitectures=arm64-v8a \
    -Pkotlin.compiler.execution.strategy=in-process "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m"
}
# Metro (~3 GB) beside a busy Gradle heap (~5 GB) passed 8 GB, so bundle the JS on its own first.
gradle :app:createBundleReleaseJsAndAssets
gradle :app:assembleRelease

# Expo's release build is signed with the public React Native debug key; re-sign with a private local key.
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  (umask 077; head -c 24 /dev/urandom | base64 > "$KEYSTORE.pass"
    keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass:file "$KEYSTORE.pass" \
      -alias fork -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=T3 Code Fork")
fi
"$build_tools/apksigner" sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE.pass" --ks-key-alias fork \
  --out "$apk.tmp" app/build/outputs/apk/release/app-release.apk
rm -f "$apk.tmp.idsig"; mv "$apk.tmp" "$apk"
ln -sfn "$(basename "$apk")" "$OUT/latest.apk"

badging=$("$build_tools/aapt2" dump badging "$apk"); badging=${badging%%$'\n'*}
grep -q "name='$PACKAGE'" <<<"$badging" || { echo "Built APK has the wrong package: $badging"; exit 1; }
echo "# Built $apk ($(du -h "$apk" | cut -f1))"
echo "# $badging"
