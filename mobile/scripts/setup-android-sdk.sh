#!/usr/bin/env bash
# installs the android sdk pieces the capacitor project needs (cmdline-tools, platform-tools, platform 36, build-tools 35)
# usage: sudo ANDROID_HOME=/opt/android-sdk mobile/scripts/setup-android-sdk.sh
# needs: curl, unzip (or python3), and JDK 21 on PATH (capacitor 8 compiles with Java 21)
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
# latest command-line tools build listed in https://dl.google.com/android/repository/repository2-3.xml
CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-16111833}"
# must match compileSdkVersion in android/variables.gradle
ANDROID_PLATFORM="${ANDROID_PLATFORM:-android-36}"
# default build-tools of android gradle plugin 8.13 (android/build.gradle)
ANDROID_BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-35.0.0}"

java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
if [ -z "$java_major" ] || [ "$java_major" -lt 21 ]; then
  echo "JDK 21 or newer is required (found: ${java_major:-none}). On Debian/Ubuntu: apt-get install -y openjdk-21-jdk-headless" >&2
  exit 1
fi

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$sdkmanager" ]; then
  echo "Installing Android command-line tools $CMDLINE_TOOLS_BUILD into $ANDROID_HOME"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/cmdline-tools.zip" "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$tmp/cmdline-tools.zip" -d "$tmp/x"
  else
    python3 -m zipfile -e "$tmp/cmdline-tools.zip" "$tmp/x"
    chmod +x "$tmp"/x/cmdline-tools/bin/*
  fi
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/x/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi

echo "Accepting SDK licenses"
yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true

echo "Installing platform-tools, platforms;$ANDROID_PLATFORM, build-tools;$ANDROID_BUILD_TOOLS"
"$sdkmanager" --sdk_root="$ANDROID_HOME" --install "platform-tools" "platforms;$ANDROID_PLATFORM" "build-tools;$ANDROID_BUILD_TOOLS"

echo
echo "Android SDK ready in $ANDROID_HOME. Export it before building:"
echo "  export ANDROID_HOME=$ANDROID_HOME"
echo "  export PATH=\"\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS:\$PATH\""
