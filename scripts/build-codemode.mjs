#!/usr/bin/env node
/**
 * Build the Termux Node sidecar for Pi CodeMode.
 *
 * The host is bundled so the App does not depend on a user-installed node_modules
 * tree. QuickJS's WASM stays a separate asset because QuickJS compiles it at
 * startup. Output is an Android asset tree:
 *
 *   target/arxd/codemode-assets/codemode/host.mjs
 *   target/arxd/codemode-assets/codemode/quickjs.wasm
 *   target/arxd/codemode-assets/codemode/manifest.json
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(app, '../../target/arxd/codemode-assets/codemode');
const host = join(output, 'host.mjs');
const wasmSource = join(app, 'node_modules/quickjs-wasi/quickjs.wasm');
const wasm = join(output, 'quickjs.wasm');

await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(app, 'codemode/host.mjs')],
  outfile: host,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  banner: { js: "import { createRequire as __arxdCreateRequire } from 'node:module'; const require = __arxdCreateRequire(import.meta.url);" },
});
await copyFile(wasmSource, wasm);

const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const hostBytes = (await readFile(host)).byteLength;
const wasmBytes = (await readFile(wasm)).byteLength;
const manifest = {
  schema: 1,
  protocol: 1,
  hostSha256: await hash(host),
  hostBytes,
  wasmSha256: await hash(wasm),
  wasmBytes,
  piCodemode: JSON.parse(await readFile(join(app, 'node_modules/@earendil-works/pi-codemode/package.json'), 'utf8')).version,
  quickjsWasi: JSON.parse(await readFile(join(app, 'node_modules/quickjs-wasi/package.json'), 'utf8')).version,
};
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`codemode sidecar: ${host} (${hostBytes} B), wasm ${wasmBytes} B`);
