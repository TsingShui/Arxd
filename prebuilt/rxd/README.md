# Pinned Android rxd

The Full build stages rxd as `target/arxd/native/arm64-v8a/librxd.so`, an ARM64
PIE executable (not a JNI library). Gradle packages it without stripping; the
existing native host exposes it through `$ARXD_RXD`. Lite still excludes rxd.

- Target: Android Bionic `aarch64-linux-android`, API 24, 16 KiB ELF LOAD alignment.
  It uses `/system/bin/linker64`; no extra musl loader is required.
- Source: `TsingShui/RxD`, revision
  `47271894d7d6359b45904a94cdd31b2dea73ee7f`. The exact source snapshot used for
  this binary is committed there; no binary release asset has been published.
- Features: default backends (Ark ABC/HAP, ASAR/ZIP/PyInstaller/wxapkg unpacking,
  DEX/APK, JVM, .NET/C#, WASM, EVM, PYC/PYZ, Lua and Flutter), MCP,
  bundled Kuna 1.978/specs and Bionic ILSpy 11.2.0.10050/reference metadata.
- SHA-256 and byte size: `arm64-v8a/manifest.json`.
- License: Apache-2.0; component notices are in the repository `NOTICE` and the
  embedded runtime archives. The source build and ELF inspection are not device
  or App-sandbox execution verification; `executionVerified` is false.

This build has no published download asset yet. No release URL is fabricated.
Stage the exact local executable once:

```sh
RXD_BINARY=/path/to/rxd/target/aarch64-linux-android/release/rxd npm run build:rxd
```

`scripts/fetch-rxd.mjs` verifies the pin, stores a content-addressed cache under
`target/arxd/cache/rxd/`, then writes the exact executable and `rxd-build.json`
metadata for Gradle. Later `npm run build:rxd` and Full release builds reuse that
cache offline. Another machine must supply the matching local executable until
an authorized release upload provides a real pinned URL. Do not commit binaries.
`RXD_MANIFEST` remains available for an explicit alternate local-build manifest.

The manual **Build Full signed APK** Actions workflow instead rebuilds the complete
Bionic engine from the pinned `sourceRevision`. A read-only RxD deployment key
provides private-source access; no binary release is published. The CI build records
its actual output hash in an explicit `RXD_MANIFEST`, and APK release metadata uses
that staged identity rather than assuming cross-host binaries have identical bytes.
