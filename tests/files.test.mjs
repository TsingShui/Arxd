import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');
const child = join(app, 'tests/files-child.mjs');
const run = async (stage, database) => JSON.parse((await promisify(execFile)(process.execPath, [child, stage, database, binary], { timeout: 15000 })).stdout.trim());

test('legacy attachments migrate independently, including conversations removed from history', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-file-migration-'));
  try {
    const database = join(dir, 'pi.sqlite');
    await run('legacy-build', database);
    const migrated = await run('legacy-reopen', database);
    const reopened = await run('reopen', database);
    assert.deepEqual(reopened.library, migrated.library);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shared captures and saved artifacts survive conversation removal; file deletion resumes after SIGKILL', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-independent-files-'));
  let process;
  try {
    const database = join(dir, 'pi.sqlite');
    const first = await run('seed', database);
    assert.equal(first.library.files.length, 2);
    assert.deepEqual((await run('reopen', database)).library, first.library);
    process = spawn(globalThis.process.execPath, [child, 'delete-crash', database, binary], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const exited = new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', (code, signal) => resolve({ code, signal })); });
    const checkpoint = new Promise((resolve) => { process.stdout.on('data', (bytes) => { stdout += bytes; if (stdout.includes('"checkpoint":true')) resolve(); }); });
    process.stderr.on('data', (bytes) => { stderr += bytes; });
    await Promise.race([checkpoint, exited.then((result) => { throw new Error(JSON.stringify({ ...result, stdout, stderr })); })]);
    process.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
    const recovered = await run('delete-reopen', database);
    assert.equal(recovered.library.files.length, 1);
    assert.deepEqual((await run('reopen', database)).library, recovered.library);
  } finally { process?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
