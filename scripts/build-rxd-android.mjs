import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
const ndk = process.env.ANDROID_NDK_HOME ?? join(sdk, 'ndk/28.2.13676358');
const prebuilt = join(ndk, 'toolchains/llvm/prebuilt');
const host = readdirSync(prebuilt).find((name) => name.startsWith(process.platform === 'darwin' ? 'darwin-' : 'linux-'));
if (!host) throw new Error(`No host toolchain in ${prebuilt}`);
const linker = join(prebuilt, host, 'bin/aarch64-linux-android26-clang');
if (!existsSync(linker)) throw new Error(`Android NDK linker missing: ${linker}`);
const target = 'aarch64-linux-android';
const features = ['backend-js', 'backend-asar', 'backend-html', 'backend-dex', 'backend-jvm', 'backend-dotnet', 'backend-wasm', 'backend-evm', 'backend-pyc', 'bundled-kuna', 'bundled-ilspy'];
// The Kuna specs are architecture-independent, but the embedded bundle is
// extracted into a target-checked cache. Generate an Android-labelled copy of
// the verified host bundle before cross-compiling the linked Kuna CLI.
const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
if (rustc.status !== 0) throw new Error('rustc -vV failed');
const hostTriple = rustc.stdout.split('\n').find((line) => line.startsWith('host: '))?.slice(6);
if (!hostTriple) throw new Error('Cannot identify the Rust host triple');
const hostKuna = join(root, 'target/kuna', hostTriple);
const kunaManifest = join(hostKuna, 'manifest.json');
const kunaBundle = join(hostKuna, 'bundle.tar.gz');
const kunaRevision = spawnSync('git', ['-C', join(root, 'third_party/kuna'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const kunaBundleRevision = existsSync(kunaManifest) ? JSON.parse(readFileSync(kunaManifest, 'utf8')).revision : undefined;
if (!existsSync(kunaBundle) || kunaRevision.status !== 0 || kunaBundleRevision !== kunaRevision.stdout.trim()) {
  const bundled = spawnSync('python3', ['scripts/build-bundled.py', '--bundle-only'], { cwd: root, stdio: 'inherit' });
  if (bundled.status !== 0) process.exit(bundled.status ?? 1);
}
const androidKuna = join(root, 'target/kuna', target);
mkdirSync(androidKuna, { recursive: true });
copyFileSync(kunaBundle, join(androidKuna, 'bundle.tar.gz'));
const kunaData = JSON.parse(readFileSync(kunaManifest, 'utf8'));
kunaData.target = target;
writeFileSync(join(androidKuna, 'manifest.json'), `${JSON.stringify(kunaData, null, 2)}\n`);
writeFileSync(join(androidKuna, 'embed.rs'), `pub const DATA: &[u8] = include_bytes!(r#"${join(androidKuna, 'bundle.tar.gz')}"#);\npub const MANIFEST: &str = include_str!(r#"${join(androidKuna, 'manifest.json')}"#);\npub const TARGET: &str = r#"${target}"#;\n`);
const kunaEmbed = join(androidKuna, 'embed.rs');
const ilspyCheck = spawnSync('python3', ['scripts/prebuilt-ilspy.py', '--android-app', 'check'], { cwd: root, stdio: 'inherit' });
if (ilspyCheck.status !== 0) process.exit(ilspyCheck.status ?? 1);
const ilspyBundle = join(root, 'prebuilt/android-ilspy', target, 'bundle.tar.gz');
const ilspyManifest = join(root, 'prebuilt/android-ilspy', target, 'manifest.json');
if (!existsSync(ilspyBundle) || !existsSync(ilspyManifest)) throw new Error(`Android ILSpy bundle is missing for ${target}`);
const androidIlspy = join(root, 'target/ilspy', target);
mkdirSync(androidIlspy, { recursive: true });
const ilspyEmbed = join(androidIlspy, 'embed.rs');
writeFileSync(ilspyEmbed, `pub const DATA: &[u8] = include_bytes!(r#"${ilspyBundle}"#);\npub const MANIFEST: &str = include_str!(r#"${ilspyManifest}"#);\npub const TARGET: &str = r#"${target}"#;\n`);
const toolchain = join(prebuilt, host, 'bin');
const result = spawnSync('cargo', ['build', '--locked', '-p', 'rxd', '--release', '--no-default-features', '--features', features.join(','), '--target', target], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: linker,
    CC_aarch64_linux_android: join(toolchain, 'aarch64-linux-android26-clang'),
    CXX_aarch64_linux_android: join(toolchain, 'aarch64-linux-android26-clang++'),
    AR_aarch64_linux_android: join(toolchain, 'llvm-ar'),
    RANLIB_aarch64_linux_android: join(toolchain, 'llvm-ranlib'),
    RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C link-arg=-Wl,-z,max-page-size=16384`,
    RXD_KUNA_EMBED_RS: kunaEmbed,
    RXD_ILSPY_EMBED_RS: ilspyEmbed,
  },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const binary = join(root, 'target', target, 'release/rxd');
const output = join(root, 'target/arxd/native/arm64-v8a/librxd.so');
mkdirSync(dirname(output), { recursive: true });
copyFileSync(binary, output);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Cannot identify the rxd source revision');
const manifest = {
  schemaVersion: 1,
  target,
  features,
  sourceRevision: revision.stdout.trim(),
  binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  binaryBytes: readFileSync(binary).byteLength,
};
const metadata = join(root, 'target/arxd/native-metadata');
mkdirSync(metadata, { recursive: true });
writeFileSync(join(metadata, 'rxd-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ binary: output, ...manifest }));
