import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('small models page skill resources, limit initial discovery and reject oversized instructions without truncating them', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-small-skill-'));
  try { await exec(process.execPath, ['--import', resolve('tests/pi-native-compat.mjs'), resolve('tests/small-skill-child.mjs'), join(directory, 'pi.sqlite'), process.env.RXD_BIN ?? resolve('../../target/release/rxd')], { timeout: 12000, maxBuffer: 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
