import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const app = resolve(import.meta.dirname, '..');
const binary = process.env.RXD_BIN ?? resolve(app, '../../target/release/rxd');
test('skills are discovered progressively, pin resources during work, and retain results through edits/deletion/reopen', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arxd-skills-'));
  try {
    const database = join(dir, 'pi.sqlite');
    for (const stage of ['seed', 'reopen']) {
      const result = await promisify(execFile)(process.execPath, [join(app, 'tests/skills-child.mjs'), stage, database, binary], { timeout: 15000 });
      assert.equal(JSON.parse(result.stdout).verified, true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
