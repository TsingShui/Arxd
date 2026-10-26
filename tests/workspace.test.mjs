import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');

// The live capacity projection is read from committed context and may still be
// pending in one process; durable snapshot fields are what a reopen must keep.
const durable = ({ capacity, ...snapshot }) => snapshot;

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
    assert.deepEqual(durable(await run('reopen')), durable(first));

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

test('editing and regenerating create switchable branch versions', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-branch-'));
  const run = async (stage) => {
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(app, 'tests/workspace-child.mjs'), stage, join(directory, 'pi.sqlite'), binary], { timeout: 15000 });
    return JSON.parse(stdout.trim());
  };
  try {
    const result = await run('branch');
    assert.equal(result.root.prompt, 'Original question');
    assert.equal(result.edited.active !== result.root.active, true);
    assert.deepEqual(result.edited.prompts, ['Edited question']);
    assert.equal(result.edited.branch.count, 2);
    assert.equal(result.edited.branch.index, 2);
    assert.equal(result.edited.conversations, 1, 'history lists one row per thread');
    assert.equal(result.regenerated.active !== result.edited.active, true);
    assert.deepEqual(result.regenerated.prompts, ['Edited question']);
    assert.equal(result.regenerated.branch.count, 3);
    assert.equal(result.back.active, result.root.active);
    assert.equal(result.back.prompt, 'Original question');
    assert.equal(result.back.branch.count, 3);
    assert.equal(result.back.branch.index, 1);
    assert.equal(result.back.conversations, 1);
    const reopened = await run('branch-reopen');
    assert.equal(reopened.active, result.root.active);
    assert.equal(reopened.turns.at(-1).prompt, 'Original question');
    assert.equal(reopened.branch.count, 3);
    assert.equal(reopened.conversations.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('custom system prompts persist as selectable profiles', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-instructions-'));
  const run = async (stage) => {
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(app, 'tests/workspace-child.mjs'), stage, join(directory, 'pi.sqlite'), binary], { timeout: 10000 });
    return JSON.parse(stdout.trim());
  };
  try {
    const first = await run('instructions');
    assert.equal(first.before.profiles.length, 0);
    assert.equal(first.before.active.cloud, null);
    assert.match(first.before.defaults.cloud, /你是 Arxd/);
    assert.match(first.before.defaults.local, /本机分析与设备任务助手/);
    assert.match(first.before.defaults.cloud, /没有 ADB 命令白名单/);
    assert.match(first.before.defaults.local, /普通 Bash 仍是 Arxd App UID/);
    assert.equal(first.after.profiles.length, 2);
    assert.equal(first.after.profiles.find((profile) => profile.id === first.cloud.id).name, 'Cloud prompt');
    assert.equal(first.after.profiles.find((profile) => profile.id === first.local.id).text, 'Custom local instructions');
    assert.equal(first.after.active.cloud, first.cloud.id);
    assert.equal(first.after.active.local, first.local.id);
    const reopened = await run('instructions-reopen');
    assert.equal(reopened.profiles.length, 2);
    assert.equal(reopened.active.cloud, first.cloud.id);
    assert.equal(reopened.active.local, first.local.id);
    assert.equal(reopened.defaults.cloud, first.after.defaults.cloud);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
