# Pinned Android rxd

`arm64-v8a/librxd.so` is the unchanged rxd CLI cross-compiled as a PIE executable
for `aarch64-linux-android`, with the Android-capable static-analysis backends.

- Source: `TsingShui/RxD`, revision `1902f1b74d61a86afdae3e902e9cc75852d84513`
- Features: JavaScript, ASAR, HTML, DEX/APK, JVM, .NET/C#, WASM, EVM, PYC,
  bundled Kuna and bundled ILSpy
- SHA-256 and byte size: `arm64-v8a/manifest.json`
- License: Apache-2.0; bundled component notices are in the repository `NOTICE`

`scripts/fetch-rxd.mjs` verifies the manifest and stages the executable under
`target/arxd/` for Gradle. To test a local rxd build, set `RXD_BINARY` and
`RXD_MANIFEST` instead of editing this directory.
