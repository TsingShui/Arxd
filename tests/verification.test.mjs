import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openDatabase } from './host-runtime.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');

function child(stage, database) {
  const process = spawn(globalThis.process.execPath, [join(app, 'tests/verification-child.mjs'), stage, database, binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let checkpoint;
  const checkpointed = new Promise((resolve) => { checkpoint = resolve; });
  process.stdout.on('data', (data) => {
    stdout += data;
    if (stdout.includes('"stage":"checkpoint"')) checkpoint();
  });
  process.stderr.on('data', (data) => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { process, checkpointed, exited };
}

test('durable sessions reopen and an interrupted real-rxd task resumes in a new process', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-durable-'));
  const database = join(directory, 'verification.sqlite');
  let interrupted;
  try {
    const seed = await child('seed', database).exited;
    assert.equal(seed.code, 0, seed.stderr + seed.stdout);
    const original = JSON.parse(seed.stdout.trim()).snapshot;
    assert.equal(original.userCount, 1);
    assert.equal(original.answerCount, 1);
    assert.equal(original.toolCount, 1);
    assert.equal(original.toolErrors, 0);
    assert.match(original.tools[0].text, /arxdProbe/);

    interrupted = child('checkpoint', database);
    await Promise.race([
      interrupted.checkpointed,
      interrupted.exited.then((result) => { throw new Error(`Checkpoint exited early: ${JSON.stringify(result)}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('No durable checkpoint reached')), 10000).unref()),
    ]);
    interrupted.process.kill('SIGKILL');
    assert.equal((await interrupted.exited).signal, 'SIGKILL');

    const recovered = await child('recover', database).exited;
    assert.equal(recovered.code, 0, recovered.stderr + recovered.stdout);
    const resumed = JSON.parse(recovered.stdout.trim()).snapshot;
    assert.equal(resumed.conversationId, original.conversationId);
    assert.equal(resumed.userCount, 2);
    assert.equal(resumed.answerCount, 2);
    assert.equal(resumed.toolCount, 2);
    assert.equal(resumed.toolErrors, 0);

    const reopened = await child('recover', database).exited;
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.deepEqual(JSON.parse(reopened.stdout.trim()).snapshot, resumed);
  } finally {
    interrupted?.process.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite transaction rollback and operation ordering match the durable storage contract', async () => {
  const database = openDatabase(':memory:');
  try {
    await database.exec('CREATE TABLE sample (value TEXT)');
    await assert.rejects(database.transaction(async (tx) => {
      await tx.run('INSERT INTO sample VALUES (?)', 'rolled back');
      throw new Error('rollback probe');
    }), /rollback probe/);
    assert.deepEqual(await database.all('SELECT value FROM sample'), []);
    const write = database.transaction(async (tx) => {
      await tx.run('INSERT INTO sample VALUES (?)', 'committed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const read = database.all('SELECT value FROM sample');
    await write;
    assert.deepEqual(await read, [{ value: 'committed' }]);
  } finally { await database.close(); }
});
