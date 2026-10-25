# Virtual Display fixture

A separate, permission-free Android launcher activity. It renders its actual
display/task/app UID. Verification must also inspect the external Android task
and display state; the fixture's text alone is not evidence.

Build artifacts belong under root `target/`. No fixture APK is committed.

Example local build (adjust the installed build-tools directory):

```sh
SDK="$ANDROID_HOME"
JDK="$JAVA_HOME"
TOOLS="$SDK/build-tools/37.0.0"
OUT="$PWD/target/virtual-display/fixture"
mkdir -p "$OUT/classes" "$OUT/dex"

"$JDK/bin/javac" --release 8 -classpath "$SDK/platforms/android-37.0/android.jar" \
  -d "$OUT/classes" tests/fixtures/virtual-display/MainActivity.java
"$TOOLS/d8" --lib "$SDK/platforms/android-37.0/android.jar" --min-api 30 \
  --output "$OUT/dex" "$OUT/classes/art/tsingshui/arxd/vdfixture/MainActivity.class"
"$TOOLS/aapt2" link -I "$SDK/platforms/android-37.0/android.jar" \
  --manifest tests/fixtures/virtual-display/AndroidManifest.xml -o "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q ../unsigned.apk classes.dex)

# Use your own local test signing key; never a production release key.
"$TOOLS/apksigner" sign --ks "$TEST_KEYSTORE" --ks-key-alias "$TEST_KEY_ALIAS" \
  --out "$OUT/app.apk" "$OUT/unsigned.apk"
adb -s "$DEVICE_SERIAL" install -r "$OUT/app.apk"
```

The fixture package is `art.tsingshui.arxd.vdfixture`. Close any existing
fixture activity before running `scripts/verify-virtual-display.py`.
The script does not force-stop other apps, unlock the phone or change
wireless-debugging configuration.
