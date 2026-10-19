# Arxd Android app

Arxd is the Android host for rxd, maintained under `apps/arxd/`. It connects
React Native/Expo 58 to Pi-durable 1.3.0, persistent SQLite and a real ARM64 rxd.

The deterministic **faux** provider is reserved for verification, not local AI. The
sidebar connection manager supports OpenAI Completions/Responses, Anthropic Messages
and Google Generative AI through Pi AI. Add a named connection, endpoint and device
credential, then enable catalog or manual models and set generation parameters. Two
connections may use the same upstream model ID. Chat selects enabled models and
supported thinking levels. Existing DeepSeek credentials and `deepseek-flash`
conversations keep their identities on upgrade. Credentials and custom headers use
Android Keystore through Expo SecureStore and are excluded from Pi documents, reports
and the APK. Live requests send conversation messages and tool results to the selected
endpoint.

The built-in Pi AI 1.3 catalog is offline metadata, not proof of account access.
Connection testing sends a separate short request with a 16-token budget and a
20-second cancellation deadline, without history, files or tools. A saved key alone is
not a successful test. Generation controls include output budget, temperature when
supported, timeout, cache preference and supported OpenAI sampling parameters. Manual
models can declare limits, thinking levels and schema-validated compatibility fields.
Local HTTP endpoints are supported; the editor states that HTTP is unencrypted. TLS
validation remains enabled.

```sh
# Local deterministic HTTP fixtures on the connected phone; no external model call.
python3 apps/arxd/scripts/verify-models.py --serial DEVICE_SERIAL
# Additionally test the phone's already-saved DeepSeek credential once.
python3 apps/arxd/scripts/verify-models.py --serial DEVICE_SERIAL --live
```

## Optional on-device models

Connections → **On-device model** downloads the pinned **Qwen3.5-2B Q4_K_M**
(1.28 GB) or imports a local **GGUF**. No API key and no automatic cloud fallback. The
text-only CPU path uses `llama.rn@0.12.9`, up to 8k context and a 1,024-token reply
budget. Thinking is opt-in: when the GGUF template exposes the switch, choose `medium`
in the model menu and reasoning streams as thinking blocks; `off` keeps the fast path.
Initial tools are `rxd_file_outline` and `shell`, with four tool rounds per user
message. Download size is not runtime RAM.

Imports are copied into private storage, bound to their full SHA-256 (`gguf-…`) and
must pass a real-engine probe: supported architecture, Jinja chat template and a
structured native tool parser. Chat-only GGUFs are rejected. Each file is limited to
8 GiB and at most 16 models are tracked. An accepted model records
`min(8192, trained context)` and a proportional output cap. Delete removes only the
weights; conversations and files remain. Missing/corrupt weights fail visibly and every
cold load re-hashes the file. Selected skills must be deselected for this limited
profile. On-device inference is not a network sandbox for shell commands.

The pinned model/revision/hash is in
`modules/rxd/android/src/main/assets/qwen-model.json`; safety and engine pins are in
[the design](../../docs/design/arxd-design.md#optional-on-device-models). Normal
`npm ci` downloads checksum-verified upstream llama.rn native artifacts. If install
scripts were deliberately disabled, run
`node node_modules/llama.rn/install/download-native-artifacts.js` before prebuild.
Models are never embedded in the APK.

```sh
node --import ./tests/pi-native-compat.mjs --test tests/local-model.test.mjs
# Device: isolated verification-enabled release build only, never production data.
python3 scripts/verify-local-model.py --serial DEVICE \
  --package art.tsingshui.arxd.qwen --download
# Exercise the real GGUF import + compatibility probe from a hash-checked fixture.
# Neither fixture mode verifies HTTPS downloading or the system file picker.
python3 scripts/verify-local-model.py --serial DEVICE \
  --package art.tsingshui.arxd.qwen --import-fixture \
  --model-file /path/to/Qwen3.5-2B-Q4_K_M.gguf
python3 scripts/verify-local-model.py --serial DEVICE \
  --package art.tsingshui.arxd.qwen --model-file /path/to/Qwen3.5-2B-Q4_K_M.gguf
```

## Native workspace

The normal launch opens the React Native workspace. Fire and Spring keep the blog
hues, with light and dark variants. Settings previews palettes and separates color
choice from system/light/dark appearance. New workspaces follow the system; legacy
Fire/dark and Spring/light choices are retained on upgrade. One root provider applies
colors, navigation surfaces, native appearance and status-bar glyphs to every product
route before the launch splash is dismissed.

Motion follows the OS reduced-motion preference and can be reduced further in settings.
Reduced mode uses immediate transitions and static busy markers while preserving task
progress and timers. Animated dialogs retain outgoing content until exit finishes and
can reopen during an interrupted dismissal. Theme changes do not restart a conversation
or cancel its work. The independent developer verification route does not open/resume
the product workspace just to load colors.

```sh
# Requires Pillow; restores system night/animation settings after the check.
python3 apps/arxd/scripts/verify-theme.py --serial DEVICE_SERIAL
```

Branding uses the repository vector glyph and the App assets under `apps/arxd/assets/`. Chat, searchable history,
file/evidence details, reports, raw output, copy, Android sharing and stop controls are
native UI. Each conversation identifies its test or real model.

Use “Run one analysis”, then send, or add a file through Android's document picker.
Imports are immutable private captures capped at the 8 GiB workspace limit with SHA-256;
Settings can lower that limit to 1 MiB per device. The Android rxd build includes JS,
ASAR, HTML, APK/DEX, JVM, .NET/C#, WASM, EVM, PYC and Kuna static analysis. The
`rxd_file_outline` tool is a bounded fast path for UTF-8 JavaScript up to 4 KiB; other
formats are analyzed through the bundled `$ARXD_RXD` CLI in the shell. No analyzed source
is executed. Evidence and exports derive from actual tool results.

The shell starts a fresh managed Bash process per call with explicit working directory,
environment, timeout and output limits. Cancellation kills the per-command process
group; arbitrary daemonized children are not promised to be cleaned up. Shell side
effects cannot be rolled back by session recovery.

## Build locally

Prerequisites: Node 24.20+, Rust 1.98 with `aarch64-linux-android`, JDK 21, Android SDK/
platform tools and NDK 28.2.13676358. Set `ANDROID_HOME` and `ANDROID_NDK_HOME` for
non-default SDK installations.

```sh
# From the repository root. Cargo still requires its pinned Kuna path dependency.
git submodule update --init third_party/kuna
cd apps/arxd
npm ci --ignore-scripts
npm run build:rxd
python3 scripts/build-preload.py
npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease --no-daemon --max-workers=2 -PreactNativeArchitectures=arm64-v8a
```

The APK is generated at
`target/arxd/gradle/_app/outputs/apk/release/app-release.apk` relative to the repository
root. The generated `android/` project is ignored; maintain native settings in `app.json`,
the config plugin and `modules/rxd/`. This locally signed release build is not a
production publication/signing workflow.

The Rust helper cross-compiles all Android-capable static-analysis backends. It stages
the executable and build identity manifest under root `target/arxd/`, outside source
control. The config plugin enables native-library extraction; `librxd.so` is a PIE
**executable**, not a JNI library. The native adapter launches it directly from
`nativeLibraryDir`, validates input/engine SHA-256 and uses the public JS outline command
as a bounded fast path. The shell exposes the same executable as `$ARXD_RXD` for other
public commands. Analyzed input is never run.

### Fast UI iteration

Build the debug variant once, then Metro hot-reloads every JS edit:

```sh
cd apps/arxd/android && ./gradlew :app:assembleDebug --max-workers=4 -PreactNativeArchitectures=arm64-v8a
adb install -r ../../target/arxd/gradle/_app/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
cd .. && npx expo start --localhost
```

Edits under `src/` land on the device in about a second. Release builds remain the
acceptance gate: the debug variant is `debuggable=true`, which `verify-android.py`
rejects by design.

The config plugin puts two Maven mirrors ahead of `google()`/`mavenCentral()`, with the
upstream repositories as fallback. The generated `android/` project is ignored.

## Verify on a connected phone

```sh
# From the repository root. Select the actual phone; no emulator is used.
adb devices -l
python3 apps/arxd/scripts/verify-android.py --serial DEVICE_SERIAL
```

The verifier installs the dedicated `art.tsingshui.arxd` package, then launches four
fresh App processes. It checks one persisted successful query, an admitted tool paused
at a durable checkpoint, recovery after force-stop and a further reopen that must not
duplicate inputs or completed tool results. It compares capture/engine identities,
requires successful real rxd results and checks the APK is non-debuggable. Reports go
under `target/arxd/evidence/`. For a UI screenshot, manually unlock the phone and keep
its display on, then pass `--screenshot`.

To repeat a completely fresh scenario, add `--reset-app`; this clears the data of
`art.tsingshui.arxd`. Without it, prior state is preserved and assertions report a
state that does not match the fresh scenario.

The verifier uses the dedicated `/verify` route. Removing an Activity from view or
remounting React is not a process-restart test.

## Focused checks

```sh
# Repository root: the host test also invokes an actual rxd CLI.
cargo build --locked --release -p rxd --no-default-features --features backend-js
cd apps/arxd
npm run typecheck
npm run lint
npm test
npx expo export --platform android --output-dir ../../target/arxd/bundle
```

`RXD_BIN` can select another host rxd executable. Host tests use the same SQLite queue/
transaction adapter and harness as Android with Node's actual SQLite driver. They cover
transaction rollback/order and real SIGKILL/new-process recovery. Device verification is
separately required for Expo SQLite, Hermes, native module loading and Android process
execution.

## Current boundaries

Android is the supported host. iOS, OAuth mobile login, a terminal UI, Node embedding,
arbitrary-package compatibility and full coding-agent extension compatibility are
separate decisions. The faux provider is verification-only. On-device inference may be
slow and is not presented as broad accuracy or performance acceptance. The App is a host
for rxd, not a replacement for the Rust analysis backends; analysis remains offline and
never executes analyzed code.
