import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
for (const window of [8192, 16384]) test(`${window}-token models compact before the bounded HTTP context fills, retain reply budgets and reopen`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-small-model-'));
  try { for (const stage of ['seed', 'reopen']) await exec(process.execPath, ['--import', resolve('tests/pi-native-compat.mjs'), resolve('tests/small-model-child.mjs'), stage, join(directory, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd'), String(window)], { timeout: 14000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
