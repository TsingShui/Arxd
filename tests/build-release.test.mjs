import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Build orchestration tests only: fixture commands record the requested variant
// and produce inert bytes. Real APK packaging/signing is verified separately.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arxd-release-'));
  const script = join(root, 'scripts/build-release.mjs');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  const native = join(root, 'node_modules/llama.rn/android/src/main/jniLibs/arm64-v8a');
  mkdirSync(native, { recursive: true });
  for (const name of ['librnllama.so', 'librnllama_v8.so']) writeFileSync(join(native, name), 'fixture');
  copyFileSync(new URL('../scripts/build-release.mjs', import.meta.url), script);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { android: { versionCode: 7 } } }));
  const driver = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.RELEASE_FIXTURE;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify({tool, args}) + '\\n');
if (tool === 'npx') {
  fs.mkdirSync(path.join(root, 'android/app'), { recursive: true });
  fs.copyFileSync(process.argv[1], path.join(root, 'android/gradlew'));
  fs.chmodSync(path.join(root, 'android/gradlew'), 0o755);
}
if (tool === 'gradlew' && args.includes('clean')) fs.rmSync(path.join(root, 'android/app/build'), {recursive: true, force: true});
if (tool === 'gradlew' && args.includes(':app:assembleRelease')) {
  const output = path.join(root, 'target/arxd/gradle/_app/outputs/apk/release');
  fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(path.join(output, 'app-release.apk'), 'fixture:' + args.find(arg => arg.startsWith('-ParxdWithRxd=')));
}
`;
  for (const command of ['npm', 'npx']) writeFileSync(join(root, 'bin', command), driver, { mode: 0o755 });
  const run = (args = []) => execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, RELEASE_FIXTURE: root, PATH: join(root, 'bin') + ':' + process.env.PATH }, stdio: 'pipe',
  });
  return { root, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const variant of ['lite', 'full', 'both']) {
  test(`${variant} release selects only its artifacts and downloads rxd only when needed`, () => {
    const { root, run, close } = fixture();
    try {
      if (variant !== 'lite') {
        mkdirSync(join(root, 'prebuilt/rxd/arm64-v8a'), { recursive: true });
        writeFileSync(join(root, 'prebuilt/rxd/arm64-v8a/manifest.json'), JSON.stringify({ sourceRevision: 'engine-fixture', binarySha256: 'a'.repeat(64) }));
      }
      // No arguments retains the existing dual-build default.
      run(variant === 'both' ? [] : ['--variant', variant]);
      const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(commands.some(({ tool }) => tool === 'npm'), variant !== 'lite');
      const prebuild = commands.find(({ tool }) => tool === 'npx');
      assert.deepEqual(prebuild.args, ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean']);
      const expected = variant === 'both' ? ['full', 'lite'] : [variant];
      const builds = commands.filter(({ args }) => args.includes(':app:assembleRelease'));
      assert.deepEqual(builds.map(({ args }) => args.find((arg) => arg.startsWith('-ParxdWithRxd='))), expected.map((name) => `-ParxdWithRxd=${name === 'full'}`));
      const output = join(root, 'target/arxd/release');
      const release = JSON.parse(readFileSync(join(output, 'release.json'), 'utf8'));
      assert.equal(release.versionCode, 7);
      assert.equal(release.engine === null, variant === 'lite');
      assert.deepEqual(release.artifacts.map((artifact) => artifact.variant), expected);
      assert.equal(readdirSync(output).filter((name) => name.endsWith('.apk')).length, expected.length);
      for (const artifact of release.artifacts) {
        const bytes = readFileSync(join(output, artifact.file));
        assert.equal(artifact.bytes, bytes.length);
        assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.ok(readFileSync(join(output, 'SHA256SUMS'), 'utf8').includes(`${artifact.sha256}  ${artifact.file}`));
      }
    } finally { close(); }
  });
}

test('missing llama native artifacts fail before clearing releases or invoking build commands', () => {
  const { root, run, close } = fixture();
  try {
    const output = join(root, 'target/arxd/release');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'keep.apk'), 'keep');
    rmSync(join(root, 'node_modules/llama.rn/android/src/main/jniLibs/arm64-v8a/librnllama.so'));
    assert.throws(() => run(['--variant', 'lite']), /Android native artifacts are missing/);
    assert.equal(readFileSync(join(output, 'keep.apk'), 'utf8'), 'keep');
    assert.equal(existsSync(join(root, 'commands.jsonl')), false);
  } finally { close(); }
});

test('invalid release variants fail before clearing existing artifacts or invoking build commands', () => {
  const { root, run, close } = fixture();
  try {
    const output = join(root, 'target/arxd/release');
    mkdirSync(output, { recursive: true });
    const sentinel = join(output, 'keep.apk');
    writeFileSync(sentinel, 'keep');
    assert.throws(() => run(['--variant', 'typo']), /--variant must be both, full or lite/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    assert.equal(existsSync(join(root, 'commands.jsonl')), false);
  } finally { close(); }
});
