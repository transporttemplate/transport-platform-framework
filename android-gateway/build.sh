#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
BUILD_TOOLS="$SDK_ROOT/build-tools/35.0.0"
ANDROID_JAR="$SDK_ROOT/platforms/android-35/android.jar"
test -f "$ANDROID_JAR"
mkdir -p build/classes build/dex .signing
"$BUILD_TOOLS/aapt2" compile --dir res -o build/resources.zip
"$BUILD_TOOLS/aapt2" link -I "$ANDROID_JAR" --manifest AndroidManifest.xml -o build/resources.apk build/resources.zip
find src -name '*.java' -print0 | xargs -0 javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$BUILD_TOOLS/core-lambda-stubs.jar:$ANDROID_JAR" -d build/classes
jar cf build/classes.jar -C build/classes .
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --min-api 26 --output build/dex build/classes.jar
cp build/resources.apk build/unsigned.apk
(cd build/dex && zip -q -u ../unsigned.apk classes.dex)
"$BUILD_TOOLS/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
if [ ! -f .signing/gateway-test.jks ]; then
 keytool -genkeypair -keystore .signing/gateway-test.jks -storepass android -keypass android -alias gateway -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Transport Gateway Physical Test, O=Transport Platform' -noprompt
 chmod 600 .signing/gateway-test.jks
fi
"$BUILD_TOOLS/apksigner" sign --ks .signing/gateway-test.jks --ks-key-alias gateway --ks-pass pass:android --key-pass pass:android --out build/transport-sms-gateway-release6.apk build/aligned.apk
"$BUILD_TOOLS/apksigner" verify --verbose build/transport-sms-gateway-release6.apk
"$BUILD_TOOLS/aapt" dump badging build/transport-sms-gateway-release6.apk
shasum -a 256 build/transport-sms-gateway-release6.apk
