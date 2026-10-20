# Release builds

Arxd publishes two APKs for one version from the same source and signing key:

| Variant | Analysis engine | Intended use |
| --- | --- | --- |
| `full` | bundled `librxd.so` | normal analysis release |
| `lite` | omitted; engine UI is unavailable | UI-only or constrained builds |

Both are `art.tsingshui.arxd`, use the same `versionCode`/`versionName`, and differ
only in whether the engine is packaged. They cannot be installed side by side;
installing one over the other with the same signing key replaces it. Switching
between the archived debug signature and a release key still requires an
uninstall.

## 1. Create the release key

Keep the key outside the repository and never put its password in a tracked file.

```sh
mkdir -p ~/.android-keys
chmod 700 ~/.android-keys
keytool -genkeypair -v \
  -keystore ~/.android-keys/arxd-release.jks \
  -alias arxd \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12 \
  -dname "CN=Arxd, O=TsingShui, C=CN"
```

Back up the keystore and passwords separately. Losing this key prevents updates
to an already distributed app; leaking it lets someone else sign an update.

## 2. Configure signing

Use the user-level Gradle properties file, not the repository's
`android/gradle.properties`:

`~/.gradle/gradle.properties`

```properties
ARXD_RELEASE_STORE_FILE=/Users/bytedance/.android-keys/arxd-release.jks
ARXD_RELEASE_STORE_PASSWORD=change-me
ARXD_RELEASE_KEY_ALIAS=arxd
ARXD_RELEASE_KEY_PASSWORD=change-me
```

Environment variables with the same names also work. Release tasks fail with an
explicit error when signing is missing; they never fall back to `debug.keystore`.

For CI, store the keystore base64 in a secret, decode it into `$RUNNER_TEMP`, and
set the four variables for the Gradle job. Never commit the keystore or print the
passwords.

## 3. Build variants locally

Prerequisites are the same as the normal build: Node, JDK 21, Android SDK/NDK,
the pinned rxd release and the preload bundle. Install dependencies with `npm ci`
(without `--ignore-scripts`) so llama.rn's checksum-verified Android native
artifacts are present. Release builds now fail early if they are missing; an
existing installation can restore them with
`node node_modules/llama.rn/install/download-native-artifacts.js`. If an earlier
native build ran without those files, use `npm ci` to discard stale CMake target
caches before rebuilding. Then:

```sh
npm run build:release
```

The command:

1. downloads and verifies the pinned `librxd.so`;
2. regenerates the Android project with the signing and build-directory plugins;
3. builds `full`, then cleans and builds `lite` with the same signing identity;
4. writes the APKs, checksums and release metadata under `target/arxd/release/`.

To build **only Lite**, without downloading the rxd engine or needing access to
its release:

```sh
npm run build:release:lite
# Equivalent: node scripts/build-release.mjs --variant lite
```

`--variant full` builds only the engine-bearing variant; the default remains both.
A Lite-only `release.json` has `engine: null` and exactly one artifact. Lite still
needs the pinned preload/runtime assets; run `python3 scripts/build-preload.py`
before the release command on a fresh machine.

Products (when building both):

```text
target/arxd/release/
├── arxd-full-0.1.0-arm64-v8a.apk
├── arxd-lite-0.1.0-arm64-v8a.apk
├── release.json
└── SHA256SUMS
```

`release.json` records the source revision and engine SHA-256 for both artifacts.
Verify a build before publishing:

```sh
apksigner verify --verbose --print-certs target/arxd/release/arxd-full-0.1.0-arm64-v8a.apk
apksigner verify --verbose --print-certs target/arxd/release/arxd-lite-0.1.0-arm64-v8a.apk
```

Both must report `Verifies` and the same certificate SHA-256.

## 4. GitHub Actions: Lite only

`.github/workflows/release-lite.yml` builds and signs **only Lite** on Ubuntu 24.04
with Node 24.20.0, JDK 21, Android SDK 37.0/build-tools 37.0.0 and NDK
28.2.13676358. It installs dependencies with `npm ci`, checks lint/types and the
build/release gate tests, and builds the authenticated pinned Termux runtime.
There is no rxd download and no extra GitHub asset-download token is needed.

Configure these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `ARXD_RELEASE_KEYSTORE_BASE64` | Base64 of the permanent release keystore |
| `ARXD_RELEASE_STORE_PASSWORD` | Keystore password |
| `ARXD_RELEASE_KEY_ALIAS` | Signing alias, e.g. `arxd` |
| `ARXD_RELEASE_KEY_PASSWORD` | Private-key password (normally the same for PKCS12) |

The keystore is restored only for the signing step under `$RUNNER_TEMP`, removed
after use, and never uploaded or cached. Signing is not available to PR events;
manual runs are restricted to `main`, and release tags must point to a commit
already on `main`. Use branch/tag protection to restrict who can change signed
source. Rotate any passwords inadvertently exposed in a terminal transcript and
update the keystore Base64 and both password secrets together; do not replace the
permanent signing key just to change its password.

After committing/pushing the workflow and application changes:

- **Actions → Build Lite release → Run workflow → main** builds downloadable
  Actions artifacts without publishing a GitHub Release.
- Pushing a tag matching `v<package.json version>` (and `expo.version`) builds and
  publishes a GitHub Release with **only the Lite APK**, `SHA256SUMS`,
  `release.json` and `verification.json`. Tags with a prerelease suffix are marked
  as prereleases. An already-existing Release is not overwritten automatically.

Before upload, `scripts/verify-lite-release.py` checks the actual APK: no
`librxd.so`; required shell, llama inference/JNI and CodeMode assets retained; product package/version;
non-debuggable/non-test-only; verification explicitly disabled; and a valid APK
signature whose certificate matches the configured keystore alias. It also checks
that the Lite-only metadata describes those exact APK bytes. This is packaging
and signing verification, not a claim of CI device testing.

Artifacts are named `arxd-lite-<commit SHA>` and retained for 14 days. Only the
separate tag-publication job has `contents: write`; the build job is read-only.
The workflow must be pushed to GitHub before it appears in Actions. Adding this
file locally does not run CI, push a tag, or publish a release.

## 5. Publishing

- Direct APK distribution: upload both files plus `SHA256SUMS` and `release.json`
  to one release.
- Google Play: upload the full build as the app. The lite build is a separate
  product decision; two artifacts with the same `applicationId` and `versionCode`
  cannot both be uploaded as separate Play apps. Build an `.aab` separately if
  Play distribution is required.
- Increment `expo.android.versionCode` in `app.json` before the next release.
  Keep `expo.version` and `package.json` `version` in sync.
- The release key is the **upload key** when Play App Signing is enabled; Google
  holds the app signing key. For sideloaded builds it is the final app signing
  key.
