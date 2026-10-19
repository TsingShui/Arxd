import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), binary = process.env.RXD_BIN ?? resolve('../../target/release/rxd'), script = resolve('tests/deletion-child.mjs');
async function run(stage, path) { await exec(process.execPath, [script, stage, path, binary], { timeout: 15000, maxBuffer: 1024 * 1024 }); }
async function crash(stage, path) {
  const child = fork(script, [stage, path, binary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let errors = ''; child.stderr.on('data', (bytes) => { errors += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  try { const gate = await new Promise((resolve, reject) => { child.on('message', (message) => { if (message.gate) resolve(message); }); child.once('exit', (code) => reject(new Error(`${stage}: exit ${code}: ${errors}`))); });
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; if (gate.pid) try { process.kill(-gate.pid, 'SIGKILL'); } catch { /* already exited */ }
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
}
test('true deletion reclaims durable rows, retains shared files and unrelated history, and joins real shell work', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-purge-')); try { const path = join(root, 'pi.sqlite'); for (const stage of ['seed', 'purge', 'reopen', 'running', 'forks', 'close-running']) await run(stage, path); } finally { await rm(root, { recursive: true, force: true }); }
});
for (const stage of ['intent-crash', 'erase-crash']) test(`deletion recovers in a new process after ${stage}`, { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-purge-crash-')); try { const path = join(root, 'pi.sqlite'); await run('seed', path); await crash(stage, path); await run('recover', path); } finally { await rm(root, { recursive: true, force: true }); }
});

test('deletion aborts and joins a real background context compaction before reclaiming history', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-purge-compaction-'));
  try { await exec(process.execPath, [resolve('tests/activity-child.mjs'), 'auto-delete', join(root, 'pi.sqlite'), binary], { timeout: 15000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('failed erasure rolls back, remains blocked/retryable, and rejects an unknown storage version', { timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-purge-retry-'));
  try { const path = join(root, 'pi.sqlite'); await run('seed', path); await run('retry', path); await run('reopen', path); }
  finally { await rm(root, { recursive: true, force: true }); }
});
