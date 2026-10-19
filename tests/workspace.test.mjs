import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');

test('workspace keeps isolated files, real results, history selection and theme across fresh processes', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-workspace-'));
  const run = async (stage) => {
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(app, 'tests/workspace-child.mjs'), stage, join(directory, 'pi.sqlite'), binary], { timeout: 10000 });
    return JSON.parse(stdout.trim());
  };
  try {
    const first = await run('seed');
    assert.equal(first.turns[0].status, 'done');
    assert.equal(first.turns[0].tools[0].isError, false);
    assert.match(first.turns[0].tools[0].text, /firstEntry/);
    assert.equal(first.files[0].name, 'firstEntry.js');
    assert.equal(first.palette, 'spring');
    assert.ok(!('artifacts' in first), 'Snapshots never materialize artifacts');
    assert.match(first.report, new RegExp(first.files[0].sha256));
    assert.deepEqual(await run('reopen'), first);

    const second = await run('second');
    assert.notEqual(second.active, first.active);
    assert.equal(second.conversations.length, 2);
    assert.equal(second.files.length, 1);
    assert.match(second.turns[0].tools[0].text, /secondEntry/);
    const selected = await run('select-first');
    assert.equal(selected.active, first.active);
    assert.deepEqual(selected.turns, first.turns);
    assert.equal(selected.report, first.report);
    assert.deepEqual((await run('reopen')).turns, first.turns);

    const invalid = await run('invalid');
    assert.equal(invalid.turns[0].status, 'failed');
    assert.equal(invalid.turns[0].tools[0].isError, true);
    assert.match(invalid.turns[0].tools[0].text, /identity mismatch/i);
    assert.equal(invalid.turns[0].tools[0].records.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
