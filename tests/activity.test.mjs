import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');
const child = join(app, 'tests/activity-child.mjs');
const run = async (stage, database) => {
  const result = await promisify(execFile)(process.execPath, [child, stage, database, binary], { timeout: 20000 });
  return JSON.parse(result.stdout.trim());
};

test('live thinking, real shell progress and durations survive a new process; compaction is separate', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-activity-'));
  try {
    const database = join(dir, 'pi.sqlite');
    const first = await run('run', database);
    const reopened = await run('reopen', database);
    assert.deepEqual(reopened.snapshot.turns, first.snapshot.turns);
    const compacted = await run('compact', database);
    assert.ok(compacted.seen.includes('compaction'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a killed thinking stream resumes without counting the process gap as measured thinking', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-thinking-recovery-'));
  let process;
  try {
    const database = join(dir, 'pi.sqlite');
    process = spawn(globalThis.process.execPath, [child, 'crash', database, binary], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const exited = new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', (code, signal) => resolve({ code, signal })); });
    const checkpoint = new Promise((resolve) => { process.stdout.on('data', (bytes) => { stdout += bytes; if (stdout.includes('"checkpoint":true')) resolve(); }); });
    process.stderr.on('data', (bytes) => { stderr += bytes; });
    await Promise.race([checkpoint, exited.then((value) => { throw new Error(JSON.stringify({ ...value, stdout, stderr })); })]);
    process.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    const recovered = await run('recover', database);
    const interrupted = recovered.snapshot.turns[0].timing.phases.filter((phase) => phase.state === 'interrupted');
    assert.ok(interrupted.length);
    assert.ok(interrupted.every((phase) => phase.durationMs === undefined));
    const reopened = await run('reopen', database);
    assert.deepEqual(reopened.snapshot.turns, recovered.snapshot.turns);
  } finally { process?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('queued tools, repeated rounds and cancellation retain distinct outcomes and timings', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-tool-rounds-'));
  try {
    const roundsDb = join(dir, 'rounds.sqlite');
    const rounds = await run('rounds', roundsDb);
    assert.deepEqual((await run('reopen', roundsDb)).snapshot.turns, rounds.snapshot.turns);
    const stoppedDb = join(dir, 'stopped.sqlite');
    const stopped = await run('cancel', stoppedDb);
    const reopened = await run('reopen-stopped', stoppedDb);
    assert.deepEqual(reopened.snapshot.turns, stopped.snapshot.turns);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multiple real CLI calls in one response remain separately visible and retain their own durations', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-parallel-activity-'));
  try {
    const database = join(dir, 'pi.sqlite');
    const first = await run('parallel', database);
    assert.equal(first.snapshot.turns[0].tools.length, 2);
    assert.deepEqual((await run('reopen', database)).snapshot.turns, first.snapshot.turns);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('default threshold and background compaction retain original history and permit real analysis', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-auto-compaction-'));
  try {
    for (const stage of ['auto-threshold', 'auto-background']) {
      const database = join(dir, stage + '.sqlite');
      const compacted = await run(stage, database);
      assert.deepEqual((await run('reopen', database)).snapshot.turns, compacted.snapshot.turns);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
