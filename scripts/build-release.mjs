#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { variant: { type: 'string', default: 'both' } } });
const variant = values.variant;
if (!['both', 'full', 'lite'].includes(variant)) throw new Error('--variant must be both, full or lite');
const variants = variant === 'both' ? ['full', 'lite'] : [variant];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const output = join(root, 'target/arxd/release');
const sourceApk = join(root, 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureAppBuildAlias() {
  const alias = join(android, 'app/build');
  const target = join(root, 'target/arxd/gradle/_app');
  await mkdir(target, { recursive: true });
  try {
    const existing = await lstat(alias);
    if (existing.isSymbolicLink()) await unlink(alias);
    else await rm(alias, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await symlink(target, alias, 'dir');
}

async function build(variant, withRxd) {
  run('./gradlew', ['clean'], android);
  // `clean` removes the generated build-directory alias; restore it before
  // Gradle recreates a real android/app/build and loses the target/ location.
  await ensureAppBuildAlias();
  run('./gradlew', [
    ':app:assembleRelease', '--no-daemon', '--max-workers=2',
    '-PreactNativeArchitectures=arm64-v8a',
    `-ParxdWithRxd=${withRxd}`,
  ], android);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const file = `arxd-${variant}-${packageJson.version}-arm64-v8a.apk`;
  const target = join(output, file);
  await copyFile(sourceApk, target);
  const bytes = (await readFile(target)).byteLength;
  const digest = await sha256(target);
  console.log(`${variant}: ${file} (${bytes} bytes, sha256 ${digest})`);
  return { variant, file, bytes, sha256: digest, withRxd };
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

if (variants.includes('full')) run('npm', ['run', 'build:rxd']);
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean']);

const artifacts = [];
for (const variant of variants) artifacts.push(await build(variant, variant === 'full'));

const manifest = variants.includes('full') ? JSON.parse(await readFile(join(root, 'prebuilt/rxd/arm64-v8a/manifest.json'), 'utf8')) : undefined;
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const appConfig = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'));
const release = {
  version: packageJson.version,
  versionCode: appConfig.expo.android.versionCode ?? 1,
  architectures: ['arm64-v8a'],
  engine: manifest ? { sourceRevision: manifest.sourceRevision, binarySha256: manifest.binarySha256 } : null,
  artifacts,
};
await writeFile(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
await writeFile(join(output, 'SHA256SUMS'), `${artifacts.map((item) => `${item.sha256}  ${item.file}`).join('\n')}\n`);
console.log(`Release artifacts written to ${output}`);
