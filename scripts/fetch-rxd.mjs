#!/usr/bin/env node
/**
 * Download and stage the pinned Android rxd executable.
 *
 * The App repo never commits the 48 MB engine. The reviewed manifest pins the
 * release URL, source revision, size and SHA-256; this script downloads only when
 * the verified cache is absent, then stages the executable for Gradle.
 *
 * Local source builds can set RXD_BINARY/RXD_MANIFEST instead of downloading.
 * Private GitHub releases use GH_TOKEN/GITHUB_TOKEN, or the local `gh auth token`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinnedManifest = join(root, 'prebuilt/rxd/arm64-v8a/manifest.json');
const manifest = JSON.parse(readFileSync(process.env.RXD_MANIFEST ? resolve(process.env.RXD_MANIFEST) : pinnedManifest, 'utf8'));
const cache = join(root, 'target/arxd/cache/rxd', `${manifest.binarySha256}.so`);
const local = process.env.RXD_BINARY ? resolve(process.env.RXD_BINARY) : undefined;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function verify(bytes) {
  if (manifest.target !== 'aarch64-linux-android') throw new Error(`unexpected rxd target: ${manifest.target}`);
  if (manifest.binaryBytes !== bytes.byteLength) throw new Error(`rxd size mismatch: ${bytes.byteLength} != ${manifest.binaryBytes}`);
  const digest = sha256(bytes);
  if (manifest.binarySha256 !== digest) throw new Error(`rxd SHA-256 mismatch: ${digest} != ${manifest.binarySha256}`);
  return digest;
}
function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}


/** GitHub release browser URLs are 404 for private repos; resolve the asset via the API. */
async function downloadReleaseAsset(url, token) {
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(url);
  const headers = { 'user-agent': 'arxd-build', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (github) {
    const [, owner, repo, tag, name] = github;
    const release = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { ...headers, accept: 'application/vnd.github+json' }, redirect: 'follow' });
    if (!release.ok) throw new Error(`rxd release lookup failed: HTTP ${release.status}${token ? '' : ' (set GH_TOKEN for a private repo)'}`);
    const asset = (await release.json()).assets?.find((item) => item.name === name);
    if (!asset) throw new Error(`rxd release asset not found: ${name}`);
    const response = await fetch(asset.url, { headers: { ...headers, accept: 'application/octet-stream' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`rxd asset download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const response = await fetch(url, { headers: { ...headers, accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`rxd download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

let bytes;
if (local) {
  if (!existsSync(local)) throw new Error(`RXD_BINARY does not exist: ${local}`);
  bytes = readFileSync(local);
} else if (existsSync(cache) && (() => { try { verify(readFileSync(cache)); return true; } catch { return false; } })()) {
  bytes = readFileSync(cache);
} else {
  if (!manifest.binaryUrl) throw new Error('manifest.binaryUrl is missing');
  const token = ghToken();
  console.log(`downloading rxd from ${manifest.binaryUrl}`);
  bytes = await downloadReleaseAsset(manifest.binaryUrl, token);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, bytes);
}
const digest = verify(bytes);
const output = join(root, 'target/arxd/native/arm64-v8a/librxd.so');
const metadata = join(root, 'target/arxd/native-metadata/rxd-build.json');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(dirname(metadata), { recursive: true });
copyFileSync(local ?? cache, output);
writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ artifact: output, sourceRevision: manifest.sourceRevision, binarySha256: digest, binaryBytes: bytes.byteLength }));
