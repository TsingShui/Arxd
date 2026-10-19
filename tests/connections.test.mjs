import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('connection-scoped models use four real HTTP protocols, separate secrets, bounded probes and fresh-process recovery', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-connections-'));
  try { for (const stage of ['seed', 'unreadable', 'reopen']) await exec(process.execPath, [resolve('tests/connections-child.mjs'), stage, join(directory, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd')], { timeout: 19000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('legacy DeepSeek documents, key reference, thinking, attachments and replies migrate in a fresh process', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-model-migration-'));
  try { for (const stage of ['legacy-build', 'legacy-reopen']) await exec(process.execPath, [resolve('tests/connections-child.mjs'), stage, join(directory, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd')], { timeout: 12000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
