import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');

test('Pi shell results persist and a crash after side effects does not rerun the script', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-shell-'));
  let pending;
  const child = (stage) => {
    const process = spawn(globalThis.process.execPath, [join(app, 'tests/shell-child.mjs'), stage, join(root, 'pi.sqlite'), binary, root]);
    let stdout = '', stderr = '', reached;
    const checkpoint = new Promise((resolve) => { reached = resolve; });
    process.stdout.on('data', (data) => { stdout += data; if (stdout.includes('"stage":"checkpoint"')) reached(); });
    process.stderr.on('data', (data) => { stderr += data; });
    const exited = new Promise((resolve, reject) => {
      process.on('error', reject);
      process.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { process, checkpoint, exited };
  };
  const snapshot = (result) => {
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.trim()).snapshot;
  };
  try {
    await mkdir(join(root, 'home'));
    await mkdir(join(root, 'usr/bin'), { recursive: true });
    const python = (await promisify(execFile)('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
    await symlink(python, join(root, 'usr/bin/python'));
    await symlink(process.execPath, join(root, 'usr/bin/node'));
    const original = snapshot(await child('rxd-seed').exited);
    const firstResult = await child('seed').exited;
    const first = snapshot(firstResult);
    assert.equal(first.toolErrors, 0, JSON.stringify(first));
    assert.equal(first.conversationId, original.conversationId);
    assert.equal(first.tools.at(-1).name, 'shell', firstResult.stderr);
    assert.match(first.tools.at(-1).text, /arxdProbe/);
    assert.match(first.tools.at(-1).text, /python/);
    assert.equal(first.tools.at(-1).details.replay, 'unsafe');
    assert.equal((await readFile(join(root, 'home/pi-shell-count'), 'utf8')), 'run\n');
    pending = child('checkpoint');
    await Promise.race([pending.checkpoint, pending.exited.then((r) => { throw new Error(JSON.stringify(r)); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('No shell checkpoint')), 10000).unref())]);
    pending.process.kill('SIGKILL');
    assert.equal((await pending.exited).signal, 'SIGKILL');
    assert.equal(await readFile(join(root, 'home/pi-shell-count'), 'utf8'), 'run\nrun\n');
    const recovered = snapshot(await child('recover').exited);
    assert.equal(recovered.conversationId, first.conversationId);
    assert.equal(recovered.toolCount, 3);
    assert.equal(recovered.toolErrors, 1);
    assert.match(recovered.tools.at(-1).text, /interrupt/i);
    assert.equal(await readFile(join(root, 'home/pi-shell-count'), 'utf8'), 'run\nrun\n');
    assert.deepEqual(snapshot(await child('recover').exited), recovered);
  } finally {
    pending?.process.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
