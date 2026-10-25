import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelServer } from './model-server.mjs';

const exec = promisify(execFile);
test('JSON model import validates before writing, rolls back failures, and survives a new Pi/SQLite process', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arxd-model-json-'));
  const server = await modelServer();
  try {
    for (const stage of ['seed', 'reopen']) {
      const result = await exec(process.execPath, ['--import', resolve('tests/pi-native-compat.mjs'), resolve('tests/model-config-child.mjs'), stage, join(directory, 'pi.sqlite'), server.url], { timeout: 25000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /"verified":true/);
    }
    assert.equal(server.requests.length, 3, 'Import and reopening do not send requests; only explicit fixture conversations do');
    const [keyed, keyless, reopened] = server.requests;
    for (const request of [keyed, reopened]) {
      assert.equal(request.headers.authorization, 'Bearer json-fixture-PRIVATE-token');
      assert.equal(request.headers['x-private-header'], 'json-fixture-PRIVATE-header');
      assert.equal(request.body.model, 'probe-model');
      assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 96);
      assert.equal(request.body.temperature, .25);
      assert.equal(request.body.top_p, .8);
    }
    assert.equal(keyless.headers.authorization, undefined);
    assert.equal(keyless.headers['x-private-header'], undefined);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
