import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('archive scopes survive a new process, opening stays archived, input restores and real shell work continues', { timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arxd-archive-'));
  try { for (const stage of ['seed', 'reopen']) await exec(process.execPath, [resolve('tests/archive-child.mjs'), stage, join(root, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd')], { timeout: 10000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(root, { recursive: true, force: true }); }
});
