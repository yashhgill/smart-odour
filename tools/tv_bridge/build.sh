#!/bin/bash
# Builds esp-bridge.apk with the Android SDK and a JDK, no Gradle needed.
set -e
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"; export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"; BT="$SDK/build-tools/34.0.0"; JAR="$SDK/platforms/android-34/android.jar"
rm -rf out; mkdir -p out/classes
"$BT/aapt2" link -o out/base.apk -I "$JAR" --manifest AndroidManifest.xml --min-sdk-version 23 --target-sdk-version 31
javac -nowarn -source 8 -target 8 -cp "$JAR" -d out/classes src/my/yashh/espbridge/*.java 2>&1 | grep -v -E "^(warning|Note|[0-9]+ warning)" || true
"$BT/d8" --release --min-api 23 --lib "$JAR" --output out $(find out/classes -name '*.class')
(cd out && zip -q base.apk classes.dex)
"$BT/zipalign" -f 4 out/base.apk out/aligned.apk
[ -f key.jks ] || keytool -genkeypair -keystore key.jks -storepass android -keypass android -alias k -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=ESP Bridge" >/dev/null 2>&1
"$BT/apksigner" sign --ks key.jks --ks-pass pass:android --out esp-bridge.apk out/aligned.apk
ls -la esp-bridge.apk
