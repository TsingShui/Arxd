import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
import { modelServer } from './model-server.mjs';

const [stage, database, binary] = process.argv.slice(2);
const statePath = join(dirname(database), 'connections-state.json');
const secretPath = join(dirname(database), 'secrets-fixture.json');
const building = stage === 'seed' || stage === 'legacy-build';
const secrets = building ? {} : JSON.parse(await readFile(secretPath, 'utf8'));
const server = await modelServer();
const host = await createHost(binary);
host.credentials = { get: async (id) => { if (secrets[id]?.broken) throw new Error('Unreadable fixture credential'); return secrets[id]; }, put: async (id, secret) => { secrets[id] = secret; await writeFile(secretPath, JSON.stringify(secrets)); }, remove: async (id) => { delete secrets[id]; await writeFile(secretPath, JSON.stringify(secrets)); } };
host.live = { fetch: (url, options) => fetch(String(url).replace('https://api.deepseek.com', server.url + '/legacy'), options) };
if (stage === 'legacy-build') await host.credentials.put('deepseek', { apiKey: 'sk-legacy-fixture-PRESERVED-123456789' });
if (stage === 'unreadable') { const saved = JSON.parse(await readFile(statePath, 'utf8')); secrets[saved.connections[2]] = { broken: true }; }
let core = await openWorkspace(openDatabase(database), host);
const state = building ? { connections: [], models: [], conversations: [] } : JSON.parse(await readFile(statePath, 'utf8'));
const draft = (protocol, path) => ({ name: path, preset: 'custom', protocol, endpoint: server.url + path, auth: 'key' });
try {
  if (stage === 'legacy-build') {
    const path = join(dirname(database), 'legacy-file.js'); const source = 'export const legacyModelFixture = 42;'; await writeFile(path, source);
    await core.model('deepseek'); await core.thinking('high'); await core.palette('spring');
    await core.attach({ id: randomUUID(), name: 'legacy-file.js', uri: pathToFileURL(path).href, source, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS' });
    await core.send('Preserve this legacy response and attachment.');
    await writeFile(statePath, JSON.stringify({ snapshot: core.getSnapshot() }));
    await core.close(); core = undefined;
    // The released app has these same Pi documents but no connection tables.
    const old = new DatabaseSync(database); old.exec('DROP TABLE arxd_connections; DROP TABLE arxd_models; DROP TABLE arxd_connections_meta;'); old.close();
  } else if (stage === 'legacy-reopen') {
    const current = core.getSnapshot(), previous = state.snapshot;
    for (const key of ['active', 'model', 'thinking', 'palette', 'files', 'turns', 'conversations']) assert.deepEqual(current[key], previous[key], key);
    assert.equal((await core.connections.list()).find((row) => row.id === 'deepseek').hasCredential, true);
    const legacyModel = core.connections.models('deepseek')[0];
    assert.equal(legacyModel.generation.maxTokens, legacyModel.definition.maxTokens);
    await core.send('Continue the migrated conversation.');
    assert.deepEqual(core.getSnapshot().turns[0], previous.turns[0]);
    assert.equal(core.getSnapshot().active, previous.active);
    assert.equal(core.getSnapshot().files[0].sha256, previous.files[0].sha256);
  } else if (stage === 'seed') {
    assert.equal(core.connections.models('deepseek')[0].id, 'deepseek');
    assert.equal(core.connections.get('deepseek').endpoint, 'https://api.deepseek.com');
    for (const [protocol, path] of [['openai-completions', '/a'], ['openai-completions', '/b'], ['openai-responses', '/responses'], ['anthropic-messages', '/anthropic'], ['google-generative-ai', '/google']]) {
      const connection = await core.connections.save(draft(protocol, path));
      const token = `credential-${connection.id}-PRIVATE`;
      await core.connections.credential(connection.id, { apiKey: token, headers: { 'X-Private-Header': 'header-' + connection.id } });
      const model = await core.connections.manual(connection.id, { id: 'probe-model', name: path, contextWindow: 128000, maxTokens: 4096, thinking: ['off'] }, { maxTokens: 96, temperature: .25, ...(protocol.startsWith('openai-') ? { samplingParams: { top_p: .8 } } : {}) }, true);
      const tested = await core.connections.test(model.id);
      assert.ok(tested.ok, path + ': ' + tested.error);
      const request = server.requests.at(-1);
      if (protocol === 'google-generative-ai') { assert.equal(request.body.generationConfig.maxOutputTokens, 16); }
      else assert.equal(request.body.max_tokens ?? request.body.max_output_tokens ?? request.body.max_completion_tokens, 16);
      await core.model(model.id); await core.send('Protocol fixture only; reply briefly.');
      assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');
      assert.equal(core.getSnapshot().turns.at(-1).provider, connection.id);
      assert.equal(core.getSnapshot().turns.at(-1).modelLabel, path);
      assert.equal(server.requests.at(-1).headers['x-private-header'], 'header-' + connection.id);
      const sent = server.requests.at(-1);
      assert.equal(sent.body.max_tokens ?? sent.body.max_output_tokens ?? sent.body.max_completion_tokens ?? sent.body.generationConfig?.maxOutputTokens, 96);
      if (protocol.startsWith('openai-')) { assert.equal(sent.headers.authorization, 'Bearer ' + token); assert.equal(sent.body.temperature, .25); assert.equal(sent.body.top_p, .8); }
      if (protocol === 'anthropic-messages') assert.equal(sent.headers['x-api-key'], token);
      if (protocol === 'google-generative-ai') assert.equal(sent.headers['x-goog-api-key'], token);
      const source = 'export function fourProtocolToolProbe(value) { return value + 42; }';
      const sourcePath = join(dirname(database), 'protocol-probe.js'); await writeFile(sourcePath, source);
      const file = { id: randomUUID(), name: 'protocol-probe.js', uri: pathToFileURL(sourcePath).href, source, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS' };
      await core.attach(file); await core.connections.updateModel(model.id, { maxTokens: 512 }, true);
      await core.send('TOOL_ROUND_PROBE: actually query the attached file.', file.id);
      const queried = core.getSnapshot().turns.at(-1);
      assert.equal(queried.answer, 'MODEL_OK');
      assert.ok(queried.tools.some((tool) => tool.name === 'rxd_file_outline' && !tool.isError && tool.text.includes('fourProtocolToolProbe')), protocol);
      state.connections.push(connection.id); state.models.push(model.id);
      state.conversations.push(core.getSnapshot().active);
      await core.select(null);
    }
    assert.notEqual(state.models[0], state.models[1]);
    await core.select(state.conversations[0]);
    const a = core.connections.get(state.connections[0]);
    const noauth = await core.connections.save({ ...draft('openai-completions', '/none'), auth: 'none' });
    const none = await core.connections.manual(noauth.id, { id: 'probe-model', name: 'none', contextWindow: 128000, maxTokens: 4096, thinking: ['off'] }, {}, true);
    assert.ok((await core.connections.test(none.id)).ok);
    assert.equal(server.requests.at(-1).headers.authorization, undefined);
    await assert.rejects(core.connections.save({ ...a, name: 'wrong' }, a.id, 1), /更改/);
    await assert.rejects(core.connections.save({ ...draft('openai-completions', '/x'), endpoint: 'https://user:password@example.com' }), /Endpoint/);
    await assert.rejects(core.connections.updateModel(state.models[0], { samplingParams: { api_key: 1 } }, true), /采样/);
    await assert.rejects(core.connections.credential(a.id, { headers: { 'X-Bad': 'bad\nvalue' } }), /请求头/);
    await core.connections.save({ ...a, endpoint: server.url + '/error' }, a.id, a.revision);
    const error = await core.connections.test(state.models[0]); assert.equal(error.ok, false);
    assert.ok(!error.error.includes(secrets[a.id].apiKey) && error.error.includes('[REDACTED]'));
    const changed = core.connections.get(a.id); await core.connections.save({ ...changed, endpoint: server.url + '/hang' }, a.id, changed.revision);
    const controller = new AbortController(); const pending = core.connections.test(state.models[0], controller.signal); setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).ok, false);
    await core.connections.updateModel(state.models[1], {}, false);
    await assert.rejects(core.model(state.models[1]), /停用/);
    await core.connections.credential(a.id, null); assert.equal((await core.connections.list()).find((row) => row.id === a.id).hasCredential, false);
    await assert.rejects(core.model(state.models[0]), /API Key/);
    const remove = host.credentials.remove;
    host.credentials.remove = async (id) => { await remove(id); throw new Error('Simulated stop after removing the credential'); };
    await assert.rejects(core.connections.remove(state.connections[1]), /Simulated/);
    assert.equal(core.connections.get(state.connections[1]).status, 'deleting');
    host.credentials.remove = remove;
    state.snapshot = core.getSnapshot();
    await writeFile(statePath, JSON.stringify(state));
    await core.close(); core = undefined;
    const bytes = await readFile(database);
    for (const secret of Object.values(secrets)) for (const value of [secret.apiKey, ...Object.values(secret.headers ?? {})]) assert.equal(bytes.includes(Buffer.from(value)), false, 'Secret must not enter the workspace database');
  } else if (stage === 'unreadable') {
    assert.deepEqual(core.getSnapshot().turns, state.snapshot.turns);
    const row = (await core.connections.list()).find((row) => row.id === state.connections[2]);
    assert.equal(row.credentialError, true);
    await assert.rejects(core.model(state.models[2]), /凭据无法读取/);
    await core.connections.credential(row.id, null);
    await core.connections.credential(row.id, { apiKey: 'reconfigured-fixture-key' });
    assert.equal((await core.connections.list()).find((item) => item.id === row.id).credentialError, false);
  } else {
    assert.deepEqual(core.getSnapshot().turns, state.snapshot.turns);
    assert.equal(core.connections.get(state.connections[2]).protocol, 'openai-responses');
    assert.equal(core.connections.models(state.connections[1])[0].enabled, false);
    assert.ok(!(await core.connections.list()).some((row) => row.id === state.connections[1]));
    assert.equal(secrets[state.connections[1]], undefined);
    const prior = core.connections.get(state.connections[2]);
    await core.connections.save({ ...prior, endpoint: server.url + '/responses' }, prior.id, prior.revision);
    await core.model(state.models[2]); await core.send('Reopened fixture request.');
    const conversation = core.getSnapshot().active;
    const turns = core.getSnapshot().turns;
    await core.connections.remove(prior.id);
    assert.equal(secrets[prior.id], undefined);
    assert.equal(core.getSnapshot().active, conversation);
    assert.deepEqual(core.getSnapshot().turns, turns);
    await assert.rejects(core.send('Deleted connection'), /停用/);
  }
  console.log(JSON.stringify({ verified: true, stage, requestCount: server.requests.length }));
} finally { await core?.close(); await server.close(); }
