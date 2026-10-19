import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('appearance and motion persist independently, preserve real analysis/history, and migrate legacy palette intent', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-appearance-'));
  try { for (const stage of ['seed', 'reopen', 'legacy', 'legacy-reopen']) await exec(process.execPath, [resolve('tests/appearance-child.mjs'), stage, join(directory, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd')], { timeout: 6500, maxBuffer: 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
