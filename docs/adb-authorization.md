# ADB authorization / ADB 授权

Arxd includes its own **local wireless ADB client**. Installing Shizuku is not
required. This establishes a verified shell channel; it does **not** change the
Arxd application's UID or grant signature permissions to the application.

入口：**设置 → 安全 → ADB 授权**。

## Pair and connect / 配对与连接

Android 11 or newer and a connected Wi-Fi network are required.

1. Open Android **Developer options → Wireless debugging** and enable it.
   Arxd's settings button opens the wireless page where supported, otherwise
   Developer options.
2. Put Android Settings and Arxd in **split screen**. On the system wireless
   debugging page, choose **Pair device with pairing code**.
3. In Arxd, enter the **pairing port** and the **six-digit pairing code**, then
   press **Pair device**. Keep the system pairing dialog open until it finishes.
   The code is cleared from Arxd's editor on submission.
4. Close the system pairing dialog. Find the **connection port** on the main
   Wireless debugging page. This is a different port.
5. Enter that port in Arxd and press **Connect**. The app uses only
   `127.0.0.1`, negotiates TLS, and executes the fixed read-only probe
   `id -u`. Only UID **2000** is shown as **ADB shell connected**.

Do not enter the Wi-Fi IP address, an entire `host:port` string or the pairing
port in the connection field. Arxd intentionally does not accept remote hosts.

A remembered pairing is displayed as **Paired, not connected** until a real
connection has been checked. This is not a persisted authorization switch.

## Disconnect and revoke

- **Disconnect** closes the channel. During pairing/connection, **Cancel** closes
  the sockets and invalidates pending results; late success cannot restore a
  cancelled channel.
- Disconnecting does **not** revoke Android's trust in the public key. To revoke
  that trust, open system Wireless debugging and **forget Arxd** under paired
  devices. Cancelling near the end of a successful pairing also does not undo
  device-side trust already accepted by Android.
- Turning off Wireless debugging or losing the transport removes the verified
  UID. Arxd never silently falls back to root, classic unencrypted ADB, another
  device or an ordinary app-UID shell.
- After restarting Arxd, the pairing identity is retained but the channel is
  disconnected. Reconnect explicitly; Android may have assigned a new port.
- There is no boot receiver, automatic reconnect or background privileged daemon
  in this first version.

## Implementation and limits

- Native code: `modules/rxd/android/src/main/java/expo/modules/arxdrxd/adb/`.
- Expo interface: `modules/rxd/adb.ts`. It exposes status, pair, connect, check,
  disconnect, opening system settings and typed Virtual Display operations.
  **No arbitrary shell execution is exported to JavaScript or the Agent.**
- An app-scoped RSA key and certificate are created in **Android Keystore**.
  The private key is non-exportable and never enters React state, SQLite,
  workspace files or an external ADB-key directory.
- Only a non-secret pairing history marker is written under
  `noBackupFilesDir/adb/`. A connection/UID is never restored from that marker.
- A one-client loopback relay gives the blocking upstream PAKE/TLS transport a
  cancellable deadline, including handshakes that have not exposed streams.
  Pairing is bounded to 30 seconds, connection/initial verification to 15 seconds,
  and subsequent checks to 5 seconds. Non-TLS connection endpoints are rejected.
- Protocol cryptography remains in pinned libadb-android 3.1.1 and Conscrypt
  Android 2.5.3. The Conscrypt provider is private to ADB; model/MCP HTTPS trust is
  not changed. The transitive SPAKE2 library is LGPL-3.0; notices, full license
  texts, pinned source links and relinking instructions ship in
  `modules/rxd/android/src/main/assets/adb-licenses/`.
- This adds native dependencies and therefore requires a **new Android build**,
  not an Expo Go or JavaScript-only update.

[Virtual Display app launch](virtual-display.md) now uses this channel to start a
shell-owned controller on Android 15+. The controller creates a display, launches
one selected app, verifies its actual task/display and owns cleanup. Input
injection is not implemented. A successful pairing alone still does not prove
display creation or app behavior on a particular Android/OEM version.

## Verification

Host policy tests:

```sh
node --import ./tests/pi-native-compat.mjs --test tests/adb.test.mjs tests/i18n.test.mjs
npx expo lint
npx tsc --noEmit
```

Native controller/real-loopback tests:

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" ./android/gradlew -p android \
  :arxd-rxd:testDebugUnitTest -ParxdWithRxd=false
```

Real pairing requires a connected Wi-Fi network and a user-authorized device.
Use an isolated application ID for device tests and store APKs, screenshots and
reports under root `target/`. Host policy tests, an APK build or a remembered
pairing marker are not evidence of a real shell connection.
