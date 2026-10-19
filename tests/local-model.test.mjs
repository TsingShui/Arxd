import test from 'node:test';
import assert from 'node:assert/strict';
import { Type, normalizeContext } from '@earendil-works/pi-ai';
import { PINNED_MODEL_ID, localDefinition, localProvider, isLocalModelId, LOCAL_MODEL } from '../src/agent/local-provider.ts';

// The Android verifier covers real GGUF → Pi → rxd. This exercises failure paths
// at the public provider stream boundary without pretending fixtures are inference.
test('local provider replays tool deltas, streams reasoning, and rejects unsafe results', async () => {
  const pinned = { id: PINNED_MODEL_ID, name: 'Qwen3.5-2B', bytes: 1280835840, sha256: 'a'.repeat(64), source: 'download', contextWindow: 8192, maxTokens: 1024, thinking: true, available: true };
  const imported = { id: 'gguf-' + 'b'.repeat(16), name: 'Imported', bytes: 1024, sha256: 'c'.repeat(64), source: 'import', contextWindow: 4096, maxTokens: 512, thinking: false, available: true };
  const tool = { name: 'outline', description: 'Inspect structure', parameters: Type.Object({ file: Type.String() }) };
  const transcript = normalizeContext({ systemPrompt: 'Base', tools: [{ ...tool, name: 'removed' }], messages: [{ role: 'user', content: 'Inspect', timestamp: 1 }] });
  transcript.messages.push({ role: 'system', content: 'Update', toolsRemoved: [{ name: 'removed' }], toolsAdded: [tool], timestamp: 2 });
  let mode = 'tool';
  const calls = [];
  const host = {
    status: () => ({ operation: 'idle', bytes: 0, totalBytes: 0, busy: false, loaded: false, models: [pinned, imported] }),
    async generate(identity, request, signal, thinking, update) {
      calls.push({ identity, request });
      assert.deepEqual(request.tools.map((entry) => entry.function.name), ['outline']);
      assert.match(request.messages[0].content, /Base/); assert.match(request.messages[0].content, /Update/);
      if (mode === 'cancel') { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); throw new Error('cancelled'); }
      const result = { reasoning: '', content: '', toolCalls: [], inputTokens: 12, outputTokens: 4, limited: false };
      if (mode === 'empty') return result;
      if (mode === 'text') { update('本地'); update('本地完成'); return { ...result, content: '本地完成' }; }
      if (mode === 'thinking') {
        assert.equal(request.thinking, true);
        thinking('先思考'); thinking('先思考工具');
        return { ...result, reasoning: '先思考工具', content: '完成' };
      }
      assert.equal(request.thinking, false);
      return { ...result, limited: mode === 'limit', toolCalls: [{ name: mode === 'unknown' ? 'removed' : 'outline', arguments: mode === 'malformed' ? '{' : mode === 'invalid' ? '{"wrong":true}' : '{"file":"sample.js"}' }] };
    },
  };
  const provider = localProvider(host);
  async function run(signal, model = LOCAL_MODEL, options = {}) {
    const events = provider.stream(model, transcript, { signal, ...options });
    const seen = []; for await (const event of events) seen.push(event);
    return { seen, message: await events.result() };
  }
  let result = await run();
  assert.equal(result.message.stopReason, 'toolUse');
  assert.deepEqual(result.message.content[0].arguments, { file: 'sample.js' });
  assert.deepEqual(result.seen.map((event) => event.type), ['start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
  // The pinned provider id keeps its original spelling for stored transcripts.
  assert.equal(calls.at(-1).identity, PINNED_MODEL_ID);
  for (mode of ['unknown', 'malformed', 'invalid', 'limit', 'empty']) {
    result = await run(); assert.equal(result.message.stopReason, 'error');
    assert.ok(!result.seen.some((event) => event.type.startsWith('toolcall')));
  }
  mode = 'text'; result = await run();
  assert.equal(result.message.content[0].text, '本地完成');
  assert.equal(result.message.usage.totalTokens, 16);
  // A thinking-capable model streams a Pi thinking block before the answer.
  mode = 'thinking'; result = await run(undefined, LOCAL_MODEL, { reasoning: 'medium' });
  assert.equal(result.message.stopReason, 'stop');
  assert.deepEqual(result.message.content.map((block) => block.type), ['thinking', 'text']);
  assert.equal(result.message.content[0].thinking, '先思考工具');
  assert.equal(result.message.thinkingLevel, 'medium');
  assert.deepEqual(result.seen.map((event) => event.type), ['start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done']);
  // An imported model streams through the same provider with its own identity and cap.
  mode = 'text';
  const definition = localDefinition(imported);
  result = await run(undefined, definition);
  assert.equal(result.message.stopReason, 'stop');
  assert.equal(calls.at(-1).identity, imported.id);
  assert.equal(calls.at(-1).request.maxTokens, 512);
  assert.equal(calls.at(-1).request.thinking, false);
  assert.equal(isLocalModelId(imported.id), true);
  assert.equal(isLocalModelId(PINNED_MODEL_ID), true);
  assert.equal(isLocalModelId('gguf-not-a-hash'), false);
  mode = 'cancel'; const abort = new AbortController();
  const running = run(abort.signal); setTimeout(() => abort.abort(), 10);
  assert.equal((await running).message.stopReason, 'aborted');
  const preAborted = new AbortController(); preAborted.abort();
  assert.equal((await run(preAborted.signal)).message.stopReason, 'aborted');
});
