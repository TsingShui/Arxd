import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
import { modelServer } from './model-server.mjs';

const [stage, database, binary, size] = process.argv.slice(2);
const window = Number(size), protocol = window === 8192 ? 'openai-completions' : 'openai-responses';
const statePath = join(dirname(database), 'small-state.json');
const server = await modelServer(0, window);
const host = await createHost(binary);
host.credentials = { get: async () => undefined, put: async () => {}, remove: async () => {} };
const core = await openWorkspace(openDatabase(database), host);
async function joinCompaction() {
  const state = await core.harness.snapshot(LiveDoc, core.getSnapshot().active, BACKGROUND_CONTEXT);
  for (const item of state?.compactions ?? []) {
    const result = await core.harness.waitForTask(item.taskId, BACKGROUND_CONTEXT);
    if (result.state.outcome.status === 'completed' && result.state.outcome.result.submissionId !== undefined) await (await core.harness.submission(result.state.outcome.result.submissionId, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  }
}
try {
  if (stage === 'seed') {
    const connection = await core.connections.save({ name: 'Small fixture', preset: 'custom', protocol, endpoint: server.url + (protocol === 'openai-responses' ? '/responses' : '/small'), auth: 'none' });
    const model = await core.connections.manual(connection.id, { id: 'small-probe', name: 'Small probe', contextWindow: window, maxTokens: 1024, thinking: ['off'] }, { maxTokens: 64 }, true);
    await core.model(model.id);
    for (let index = 0; index < 18; index++) {
      await core.send(`Round ${index}: ` + 'history '.repeat(Math.floor(window / 40)));
      await joinCompaction();
      assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');
      assert.equal(core.getSnapshot().turns.at(-1).status, 'done');
    }
    const conversation = await core.harness.conversation(core.getSnapshot().active, BACKGROUND_CONTEXT);
    const entries = (await conversation.entries({ order: 'ascending' }, 256, undefined, BACKGROUND_CONTEXT)).items;
    assert.equal(entries.filter((entry) => entry.kind === 'pi.user').length, 18);
    assert.ok(entries.some((entry) => entry.kind === 'pi.compaction'));
    const summaries = server.requests.filter((request) => JSON.stringify(request.body.messages ?? request.body.input).includes('You are a context summarization assistant.'));
    assert.ok(summaries.length > 0);
    const ordinary = server.requests.filter((request) => !summaries.includes(request));
    assert.ok(ordinary.every((request) => (request.body.max_tokens ?? request.body.max_completion_tokens ?? request.body.max_output_tokens) === 64));
    await writeFile(statePath, JSON.stringify({ connection: connection.id, model: model.id, snapshot: core.getSnapshot() }));
    console.log(JSON.stringify({ verified: true, window, summaries: summaries.length, ordinary: ordinary.length }));
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(core.getSnapshot().turns, state.snapshot.turns);
    const connection = core.connections.get(state.connection);
    await core.connections.save({ ...connection, endpoint: server.url + (protocol === 'openai-responses' ? '/responses' : '/small') }, connection.id, connection.revision);
    await core.send('Continue the small-model task after a fresh process.'); await joinCompaction();
    assert.equal(core.getSnapshot().turns.at(-1).answer, 'MODEL_OK');
    assert.equal(core.getSnapshot().active, state.snapshot.active);
  }
} finally { await core.close(); await server.close(); }
