import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../src/workspace/core.ts';
import { MAX_MODEL_CONFIG_BYTES, MODEL_CONFIG_EXAMPLE } from '../src/workspace/connections.ts';
import { setActiveLocale } from '../src/i18n/base.ts';
import { openDatabase } from './host-runtime.mjs';

setActiveLocale('en');
const [stage, path, endpoint] = process.argv.slice(2);
const secretPath = join(dirname(path), 'fixture-secrets.json');
const statePath = join(dirname(path), 'fixture-state.json');
const secrets = stage === 'seed' ? {} : JSON.parse(await readFile(secretPath, 'utf8'));
const token = 'json-fixture-PRIVATE-token', header = 'json-fixture-PRIVATE-header';
let sendRequest = fetch;
const host = {
  // This test exercises model configuration and the real durable harness only,
  // not Android adapters or rxd analysis. All HTTP responses are deterministic fixtures.
  info: { engineSha256: '0'.repeat(64), sourceRevision: 'model-json-fixture', abi: 'host', sdk: 0, pageSize: 4096 },
  live: { fetch: (...args) => sendRequest(...args) },
  credentials: {
    get: async (id) => secrets[id],
    put: async (id, secret) => { secrets[id] = secret; await writeFile(secretPath, JSON.stringify(secrets)); },
    remove: async (id) => { delete secrets[id]; await writeFile(secretPath, JSON.stringify(secrets)); },
  },
};
const database = openDatabase(path);
const core = await openWorkspace(database, host);
const config = {
  name: 'JSON fixture (deterministic HTTP)', endpoint: endpoint + '/json',
  apiKey: token, headers: { 'X-Private-Header': header },
  models: [
    { id: 'probe-model', name: 'Imported fixture', contextWindow: 128000, maxTokens: 4096, thinking: ['off', 'high'], compat: { supportsStore: false }, generation: { maxTokens: 96, temperature: .25, samplingParams: { top_p: .8 } } },
    { id: 'disabled-model', enabled: false },
  ],
};
try {
  if (stage === 'seed') {
    const original = core.connections.get('deepseek');
    const originalModel = core.getSnapshot().model;
    const before = async () => ({
      rows: await core.connections.list(), models: core.connections.models(), secrets: structuredClone(secrets),
      dbRows: await database.all('SELECT value FROM arxd_connections ORDER BY id'),
      dbModels: await database.all('SELECT value FROM arxd_models ORDER BY id'),
    });
    const invalid = [
      'null', '[]', '{"apiKey":"' + token + '",',
      JSON.stringify({ ...config, unexpected: true }),
      JSON.stringify({ ...config, apiKey: 'bad key' }),
      JSON.stringify({ ...config, headers: { Host: 'example.com' } }),
      JSON.stringify({ ...config, endpoint: 'https://user:pass@example.com/v1' }),
      JSON.stringify({ ...config, endpoint: 'https://example.com/v1?key=private' }),
      JSON.stringify({ ...config, endpoint: 42 }),
      JSON.stringify({ ...config, name: null }),
      JSON.stringify({ ...config, auth: 'none' }),
      JSON.stringify({ ...config, auth: 'account', preset: 'openai-codex' }),
      JSON.stringify({ ...config, protocol: 'unsupported' }),
      JSON.stringify({ ...config, models: [] }),
      JSON.stringify({ ...config, models: Array(129).fill({ id: 'too-many' }) }),
      JSON.stringify({ ...config, models: [config.models[0], { id: ' probe-model ' }] }),
      JSON.stringify({ ...config, models: [config.models[0], { id: 'broken', contextWindow: 100 }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', enabled: 'false' }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', generation: null }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', generation: { timeoutMs: 10 } }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', generation: { samplingParams: { unsupported: 1 } } }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', compat: { unsupported: token } }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', generation: { samplingParams: { [token]: 1 } } }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', contextWindow: '128000' }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', thinking: [] }] }),
      JSON.stringify({ ...config, models: [{ id: 'bad', unknown: true }] }),
      ' '.repeat(MAX_MODEL_CONFIG_BYTES + 1),
      '"你好'.repeat(12000),
    ];
    const baseline = await before();
    for (const json of invalid) {
      await assert.rejects(core.connections.importJson(json), (error) => {
        assert.equal(error.message.includes(token), false, 'Invalid JSON must not echo credentials');
        return true;
      });
      assert.deepEqual(await before(), baseline, 'Validation must not leave partial connection/model/credential records');
    }
    // A credential store may write successfully and then throw. Cleanup still
    // removes its fresh ID and the exception never echoes its sensitive payload.
    const put = host.credentials.put;
    host.credentials.put = async (...args) => { await put(...args); throw new Error(token); };
    await assert.rejects(core.connections.importJson(JSON.stringify(config)), (error) => !error.message.includes(token) && /Could not import/.test(error.message));
    host.credentials.put = put;
    assert.deepEqual(await before(), baseline);

    // Fail on the second model insert, after the connection and first model.
    // SQLite must roll back the entire publication and discard the staged key.
    await database.exec("CREATE TEMP TRIGGER fail_json_import BEFORE INSERT ON arxd_models WHEN NEW.upstream_id = 'fail-storage' BEGIN SELECT RAISE(ABORT, 'fixture-storage-failure'); END");
    await assert.rejects(core.connections.importJson(JSON.stringify({ ...config, models: [config.models[0], { id: 'fail-storage' }] })), /Could not import/);
    await database.exec('DROP TRIGGER fail_json_import');
    assert.deepEqual(await before(), baseline);

    const imported = await core.connections.importJson('\uFEFF' + JSON.stringify(config));
    const models = core.connections.models(imported.id);
    assert.equal(imported.protocol, 'openai-completions');
    assert.equal(imported.preset, 'custom');
    assert.equal(imported.auth, 'key');
    assert.equal(models.length, 2);
    assert.equal(models[0].definition.provider, imported.id);
    assert.equal(models[0].definition.baseUrl, endpoint + '/json');
    assert.equal(models[0].source, 'manual');
    assert.deepEqual(models[0].generation, config.models[0].generation);
    assert.equal(models[1].definition.name, 'disabled-model');
    assert.equal(models[1].definition.contextWindow, 128000);
    assert.equal(models[1].definition.maxTokens, 16384);
    assert.equal(models[1].generation.maxTokens, 16384);
    assert.equal(models[1].enabled, false);
    assert.equal(core.getSnapshot().model, originalModel, 'Import must not switch models');
    assert.deepEqual(core.connections.get('deepseek'), original, 'Existing connections are unchanged');
    assert.equal((await core.connections.list()).find((row) => row.id === imported.id).hasCredential, true);
    assert.equal(core.getSnapshot().models.find((row) => row.id === models[0].id).available, true);
    assert.deepEqual(core.getSnapshot().models.find((row) => row.id === models[0].id).thinking, ['off', 'high']);
    await assert.rejects(core.model(models[1].id), /停用/);

    // Re-import is explicitly additive; same upstream IDs remain connection-scoped.
    const second = await core.connections.importJson(JSON.stringify(config));
    assert.notEqual(second.id, imported.id);
    assert.notEqual(core.connections.models(second.id)[0].id, models[0].id);
    assert.deepEqual(core.connections.models(imported.id), models);

    const keyless = await core.connections.importJson(JSON.stringify({ name: 'Keyless fixture', endpoint: endpoint + '/none', auth: 'none', models: [{ id: 'probe-model' }] }));
    assert.equal(secrets[keyless.id], undefined);
    await core.model(models[0].id);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    sendRequest = async (...args) => { started.resolve(); await release.promise; return fetch(...args); };
    const sending = core.send('Deterministic HTTP fixture only.');
    try {
      await started.promise;
      const busyState = await before();
      await assert.rejects(core.connections.importJson(JSON.stringify(config)), /Stop the running task first/);
      assert.deepEqual(await before(), busyState, 'Import must not mutate model configuration while a task runs');
    } finally { sendRequest = fetch; release.resolve(); await sending; }
    assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');
    await core.select(null);
    await core.model(core.connections.models(keyless.id)[0].id); await core.send('Deterministic keyless fixture only.');
    assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');

    const pending = await core.connections.importJson(JSON.stringify({ name: 'Credential pending', endpoint: endpoint + '/pending', models: [{ id: 'pending-model' }] }));
    assert.equal((await core.connections.list()).find((row) => row.id === pending.id).hasCredential, false);
    const headersOnly = await core.connections.importJson(JSON.stringify({ name: 'Headers only', endpoint: endpoint + '/headers', headers: { Authorization: 'Bearer ' + header }, models: [{ id: 'headers-model' }] }));
    assert.equal((await core.connections.list()).find((row) => row.id === headersOnly.id).hasCredential, true);

    // The in-app example itself must be valid.
    const example = await core.connections.importJson(MODEL_CONFIG_EXAMPLE);
    assert.equal(core.connections.models(example.id).length, 1);
    await core.select(null);
    await core.model(models[0].id); await core.thinking('high');
    await writeFile(statePath, JSON.stringify({ imported, models, original, keyless: keyless.id, pending: pending.id, headersOnly: headersOnly.id, snapshot: core.getSnapshot() }));
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(core.connections.get(state.imported.id), state.imported);
    assert.deepEqual(core.connections.models(state.imported.id), state.models);
    assert.deepEqual(core.connections.get('deepseek'), state.original);
    assert.equal(core.getSnapshot().model, state.models[0].id);
    assert.equal(core.getSnapshot().thinking, 'high');
    assert.deepEqual(core.getSnapshot().turns, state.snapshot.turns);
    const rows = await core.connections.list();
    assert.equal(rows.find((row) => row.id === state.imported.id).hasCredential, true);
    assert.equal(rows.find((row) => row.id === state.pending).hasCredential, false);
    assert.equal(rows.find((row) => row.id === state.headersOnly).hasCredential, true);
    assert.equal(core.getSnapshot().models.find((row) => row.connectionId === state.keyless).available, true);
    await core.thinking('off'); await core.send('Deterministic fixture after reopening SQLite in a new process.');
    assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');
  }
  console.log(JSON.stringify({ verified: true, stage, provider: 'deterministic HTTP fixture (not a live model)' }));
} finally { await core.close(); }
for (const suffix of ['', '-wal']) {
  const bytes = await readFile(path + suffix).catch((error) => { if (error.code !== 'ENOENT') throw error; return Buffer.alloc(0); });
  for (const secret of [token, header]) assert.equal(bytes.includes(Buffer.from(secret)), false, 'Credentials must never enter workspace SQLite or WAL');
}
