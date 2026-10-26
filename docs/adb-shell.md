# Background Agent and Termux ADB / 后台 Agent 与 ADB Shell

入口：**设置 → 工具 → ADB Shell**，或对话侧栏的 **ADB Shell**。

## What runs

- Arxd embeds its own Termux-compatible Bash/Python/Node runtime. It does not
  require the external Termux App, Termux:API, Shizuku or root.
- **Install android-tools** installs the original upstream Termux package with
  normal official APT repository signatures and HTTPS verification. First
  installation requires network access. It is not part of the offline base
  bundle. The installer repairs package dependencies without allowing removal;
  it can update shared dependencies and keeps APT's real output.
- This is a real `adb` executable, not a command-name shim. The Agent's existing
  `shell` tool can run arbitrary `adb shell`, `exec-out`, pipelines and scripts.
  There is no ADB command/package allowlist. The ordinary Bash process remains
  Arxd's App UID; a normal authorized Android ADB shell is UID **2000**, not root.
- The default ADB server socket is an App-private filesystem Unix socket, not
  another terminal's TCP port 5037. APT's cache is also inside Arxd storage.

## Setup

1. Install android-tools. Setup/Run enables background sessions and requests
   notification access; refusing permission does not silently start a service.
2. **Start ADB server**. This uses the existing managed-process owner and its
   notification. View or stop it in Processes, or press **Stop ADB server**.
3. Open Android Wireless debugging yourself. Use split screen while the pairing
   dialog is open, enter its pairing port and six-digit code, then pair.
4. Enter the separate connection port. Connect verifies a real `id -u = 2000`
   before publishing the default `ANDROID_SERIAL=127.0.0.1:PORT` for new scripts.
5. Run a script or ask the Agent to carry out the explicitly authorized task.

The CLI is a **different ADB client** from the old native Virtual Display
controller. Its standard upstream adb keys are ordinary files in the App-private
Termux Home, not non-exportable Keystore keys. Pair the CLI separately. The UI
sends the six-digit code only over managed stdin, not through retained scripts,
arguments or logs. Manually writing a code into a shell script has no such
protection. Forget the CLI client in Android Settings to revoke device trust.

Pairing is not a permanent connection. No server or Agent session is
automatically restored by this feature after App-process death. A running adb
server otherwise follows upstream adb behavior; scripts can change its
connections/settings. Stopping its managed server is not revoking its keys.

## Background lifetime

**Background Agent sessions** is opt-in. New send/edit/regenerate/compaction
operations acquire a native foreground-service lease before starting, retain it
through model requests and tools, and release it on completion/failure. Multiple
conversations have independent leases. The service owns a real RN Headless JS
task so timers continue after Activity.onPause, not merely a decorative
notification. Local generation may continue while that lease is active; without
it the old background-cancellation policy remains.

The notification opens Arxd and offers **Stop**. It requests cancellation of the
owned Agent operations, including their managed shell calls. Existing unrelated
MCP/services are not stopped. The service requests cancellation after 30 minutes;
no unkillable/infinite keepalive is promised. RN's wake lock is released when
the service ends. Android, memory pressure or the user can still kill the App.

Pi-durable and SQLite retain task intent/results. Shell calls remain
`replay: unsafe`: interrupted operations are not blindly executed again.
A foreground service is not a durability substitute. Normal process restart
requires reopening storage, not reconstructing a React screen.

## Screen and input

Examples in the Agent's managed shell after setup:

```sh
id -u                     # ordinary Arxd UID
adb shell id -u            # normally 2000
adb shell am start -W -n PACKAGE/LAUNCHER_ACTIVITY
adb exec-out screencap -p > "$ARXD_WORKSPACE/screen.png"
adb shell input tap X Y
adb shell input swipe X1 Y1 X2 Y2 300
adb shell input text hello
adb shell input keyevent KEYCODE_BACK
```

Coordinates refer to the real device display; verify the foreground App,
rotation and lock state before input. `input text` is not general Unicode/CJK
input. Screenshot files are real images, not text results; this change does not
pretend that a text-only model can see them or automatically upload them to a
cloud model. Do not bypass lockscreen, FLAG_SECURE or DRM protections.

**This is broad device authority, not an App sandbox.** ADB can affect other
Apps/settings; arbitrary shell can outlive cancellation by detaching children.
Opening the CLI does not mean an untrusted APK/document/tool output is a user
instruction. Do not execute analyzed samples or disclose credentials.

## Verification boundaries

Use an isolated `art.tsingshui.arxd.*` package with verification enabled; never
clear production Arxd data. `/verify-background` is guarded by the native build
flag, labels its deterministic provider as offline/not live, and uses real
Pi-durable, SQLite and shell execution.

Run `python3 scripts/verify-background-adb.py --serial DEVICE --package TEST_PACKAGE`
after CLI installation/pairing. `--relay-port PORT` is an explicit host-assisted
alternative, not a wireless-pairing test. The runner only launches/taps/types in
the permission-free fixture.

Evidence/APKs go under `target/adb-shell/`. Record USB-host-assisted ADB,
in-App wireless pairing, simulator and physical-device results separately.
A host relay or screenshot of a settings page is not a wireless TLS pairing
test. Successful TypeScript/build checks are not device verification.
