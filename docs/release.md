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

## 3. Build both variants

Prerequisites are the same as the normal build: Node, JDK 21, Android SDK/NDK,
the pinned rxd release and the preload bundle. Then:

```sh
npm run build:release
```

The command:

1. downloads and verifies the pinned `librxd.so`;
2. regenerates the Android project with the signing and build-directory plugins;
3. builds `full`, then cleans and builds `lite` with the same signing identity;
4. writes the APKs, checksums and release metadata under `target/arxd/release/`.

Products:

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

## 4. Publishing

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
