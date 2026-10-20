import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(root, '../../target/release/rxd');

test('language override persists through real Pi/SQLite and four separate processes without changing history', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-language-'));
  try {
    const results = [];
    for (const stage of ['seed', 'reopen-en', 'reopen-zh', 'reopen-system']) {
      const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'tests/language-child.mjs'), stage, join(directory, 'pi.sqlite'), binary], { timeout: 10000 });
      results.push(JSON.parse(stdout.trim()));
    }
    assert.ok(results.every((value) => value.verified));
    assert.equal(new Set(results.map((value) => value.active)).size, 1);
    assert.deepEqual(results.map((value) => value.language), ['en', 'zh', 'system', 'system']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
