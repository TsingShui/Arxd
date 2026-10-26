# Virtual Display app launch / 虚拟屏幕启动 App

**Experimental / 实验功能，默认关闭。**

入口：**设置 → 工具 → 实验功能**，先启用虚拟屏幕实验，再进入副屏页面。
ADB 授权页链接到实验功能，不再把副屏作为默认工具展示。Native 启动准入与
截图均检查实验开关；关闭开关会停止/取消其会话。旧路由不能绕过此开关。

常规可见使用优先选择 [分屏辅助分析](split-screen.md)。

1. First connect and verify Arxd's local ADB channel.
2. Select a launcher app and press **Launch on virtual display**.
3. Arxd creates a portrait display using the phone's density (normally 360 dp
   wide, bounded to 720–1080 × 1280–1920 pixels) and launches the selected app there.
   Matching density avoids cached font-metric clipping in some app frameworks. A running result includes the actual **display ID, task ID and
   shell UID 2000**, not just an activity-start acknowledgement.
4. **Refresh preview** captures a read-only JPEG from that display. No touch or
   keyboard events are forwarded.
5. **Stop**, leaving the route, transport EOF or lease expiry releases the
   virtual display and its tasks.

This version requires **Android 15+**, the primary Android user, and shell
permissions for trusted/always-unlocked displays. OEMs that restrict those
capabilities fail explicitly; Arxd does not downgrade to an untrusted display
or retry launching on the physical screen.

## Ownership and cleanup

The Android app does not grant itself signature permissions. It starts the
APK's pinned `DisplayServer` entry with `app_process` through the already
verified ADB stream. The controller checks its own real Linux UID is 2000.

The controller owns a dedicated ImageReader surface and a trusted virtual
display. Its required flags include:

- `OWN_CONTENT_ONLY`: no mirroring of the physical screen;
- `OWN_DISPLAY_GROUP` and `ALWAYS_UNLOCKED`: an independent test display,
  without changing the phone's lock-screen configuration or credentials;
- `OWN_FOCUS` and `STEAL_TOP_FOCUS_DISABLED`: keep the physical display's
  focus separate;
- `DESTROY_CONTENT_ON_REMOVAL`: finish display-local activities on removal,
  instead of migrating them to the physical screen.

The server has no exported Android service, socket listener, boot receiver or
persistent command queue. It accepts only framed start/status/snapshot/stop
requests on its ADB stdin/stdout stream, correlated with a per-session token.

The client refreshes a **30-second lease** every five seconds. A dead client,
closed stdin or unrefreshed lease closes the display. Sessions also have a
**10-minute absolute lifetime** and are never restarted automatically.
Startup, command reads, snapshots and stop acknowledgements have bounded
timeouts. Unconfirmed cleanup is shown as pending, not silently marked successful;
the app can later reconcile display removal.

No preview frame, task, live display ID or active privilege is stored in SQLite
or restored across a process restart. Preview frames remain in memory unless an
explicit test harness saves evidence under `target/`.

## App/task safeguards and limitations

- Only an enabled, exported launcher app can be selected; the current Arxd
  package cannot launch itself through this UI.
- Existing target-app tasks are rejected before display creation. For
  single-task/single-instance launchers, the server additionally checks for
  activity records hidden in the middle of other tasks.
- New launches explicitly specify the owned display ID, use new/multiple-task
  flags, and are excluded from recents. There is no force-stop, data clearing,
  existing-task reparenting, accessibility service or input injection.
- Launch success is checked against ActivityManager's real running task/display
  information. An invalid/default display, mismatched app, wrong UID or missing
  task is a failure.
- This is **not an application-data, network or OS security sandbox**. The
  installed app uses its existing data and permissions and may perform its normal
  startup/network behavior. Its own redirects or system components are not an
  isolation guarantee.
- DRM/secure-window content is not forcibly captured. App authentication and
  credential-encrypted storage protections are not bypassed.
- Hidden shell framework interfaces may differ on OEM builds. Unsupported
  devices fail rather than switching to root or a physical-screen launch.

## Code

- `modules/rxd/android/src/main/java/expo/modules/arxdrxd/display/`:
  request validation, session ownership and the shell controller.
- `modules/rxd/android/src/main/java/expo/modules/arxdrxd/adb/ShellDisplaySession.kt`:
  bounded protocol over the authenticated ADB stream.
- `src/ui/VirtualDisplayScreen.tsx`: app picker, status, read-only preview and stop.
- `tests/fixtures/virtual-display/`: a separate permission-free Android fixture.

Native changes require a new APK, not an Expo Go or JavaScript-only update.

## Verification and evidence

```sh
npx expo lint
npx tsc --noEmit
node --import ./tests/pi-native-compat.mjs --test tests/virtual-display.test.mjs
ANDROID_HOME="$HOME/Library/Android/sdk" ./android/gradlew -p android --offline \
  :arxd-rxd:testDebugUnitTest -ParxdWithRxd=false

# After installing an isolated Arxd build and the fixture:
python3 scripts/verify-virtual-display.py --serial DEVICE_SERIAL \
  --package art.tsingshui.arxd.adbtest
```

The physical-device script invokes the **same shipped controller entry** via
USB host ADB. It checks the real display/task association with external
DisplayManager/ActivityManager dumps, captures the fixture surface, checks
existing-task refusal, and verifies normal stop, EOF, startup cancellation and
lease expiry leave no fixture display/task.

**USB verification is not evidence that in-app wireless pairing worked.** Record
wireless transport, physical-device and simulator results separately. The fixture
is a real Android app with an explicitly labelled test screen, not a live model
response or a claim about every third-party app.
