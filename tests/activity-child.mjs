import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { UserEntry, LiveDoc } from '@earendil-works/pi-durable';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const root = dirname(database);
await mkdir(`${root}/home`, { recursive: true });
const host = await createHost(binary, undefined, { root, jobs: new Map(), previews: new Map() });
const captures = [];

let request = 0;
let summaryMode = 'ok';
const summaryLimits = [];
host.live = {
  getKey: async () => 'sk-offline-fixture-1234567890',
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const summary = body.messages.some((message) => typeof message.content === 'string' && message.content.includes('You are a context summarization assistant.'));
    if (summary) {
      summaryLimits.push(body.max_tokens ?? body.max_completion_tokens);
      if (summaryMode === 'error') return new Response(JSON.stringify({ error: { message: 'offline compaction failure' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const index = request++;
    const toolResults = body.messages.filter((message) => message.role === 'tool').length;
    const toolResult = toolResults > 0;
    const chunks = summary ? [
      [summaryMode === 'slow' ? 5000 : 250, { content: 'OFFLINE FIXTURE SUMMARY. Original source entries stay retained.' }, 'stop'],
    ] : toolResult ? [
      [150, { reasoning_content: 'Offline fixture: interpret the actual shell output.' }],
      [200, { content: 'OFFLINE FIXTURE: shell result inspected.' }, 'stop'],
    ] : [
      [150, { reasoning_content: 'Offline fixture thinking, not a live model.' }],
      [stage === 'crash' ? 10000 : 250, { content: 'I will run the trusted fixture command.' }],
      [200, { tool_calls: [{ index: 0, id: `offline-call-${index}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ script: "printf 'first-output-✓\\n'; sleep 1.4; printf 'second-output-✓\\n'", timeoutMs: 10000 }) } }] }],
      [0, {}, 'tool_calls'],
    ];
    if (stage === 'rounds' && toolResults < 3) {
      const scripts = toolResults === 0 ? ["printf 'first-error'; sleep .7; exit 23", "sleep .7; printf 'second-output-✓\\n'"] : ["printf 'third-success\\n'"];
      chunks.splice(0, chunks.length,
        [150, { reasoning_content: 'Offline fixture: multiple calls and a later successful round.' }],
        [200, { tool_calls: scripts.map((script, call) => ({ index: call, id: `round-${index}-${call}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ script, timeoutMs: 10000 }) } })) }],
        [0, {}, 'tool_calls']);
    }
    if (stage === 'parallel' && !toolResult) chunks.splice(0, chunks.length,
      [150, { reasoning_content: 'Offline fixture: query two immutable captures in one response.' }],
      [200, { tool_calls: captures.map((file, call) => ({ index: call, id: `parallel-${index}-${call}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ script: `sleep .5; printf '%s\\n' ${JSON.stringify(file.source)}; "$ARXD_RXD" --version`, timeoutMs: 10000 }) } })) }],
      [0, {}, 'tool_calls']);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const abort = () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); } };
        options.signal?.addEventListener('abort', abort, { once: true });
        void (async () => {
          try {
            for (const [wait, delta, finish] of chunks) {
              await delay(wait, undefined, { signal: options.signal });
              if (closed) return;
              const chunk = { id: `offline-${index}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            if (!closed) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); closed = true; controller.close(); }
          } catch (error) { if (!closed) { closed = true; controller.error(error); } }
          finally { options.signal?.removeEventListener('abort', abort); }
        })();
      },
      cancel() { closed = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
};
const workspace = await openWorkspace(openDatabase(database), host);
const seen = new Set();
let checkpointed = false;
let stop;
const unsubscribe = workspace.subscribe((snapshot) => {
  const turn = snapshot.turns.at(-1);
  if (turn?.phase) seen.add(turn.phase);
  if (turn?.activities.filter((block) => block.kind === 'tool' && block.state === 'running').length >= 2) seen.add('parallel');
  if (turn?.activities.some((block) => block.kind === 'tool' && block.state === 'pending') && turn.activities.some((block) => block.kind === 'tool' && block.state === 'running')) seen.add('queue');
  if (turn?.activities.some((block) => block.kind === 'tool' && block.state === 'running' && !block.result)) seen.add('live-tool');
  if (turn?.activities.some((block) => block.kind === 'tool' && block.output?.includes('first-output-✓'))) seen.add('live-output');
  if (stage === 'cancel' && !stop && turn?.activities.some((block) => block.kind === 'tool' && !!block.output)) stop = workspace.stop();
  if (snapshot.compactions.length) {
    seen.add('compaction');
    if (stage === 'compact') assert.equal(snapshot.busy, false, 'manual compaction must not turn a settled answer into a running answer');
  }
  if (stage === 'crash' && turn?.phase === 'thinking' && !checkpointed) {
    checkpointed = true;
    console.log(JSON.stringify({ checkpoint: true }));
  }
});
try {
  if (['run', 'crash', 'rounds', 'cancel', 'parallel'].includes(stage)) {
    await workspace.model('deepseek');
    await workspace.thinking('high');
    if (stage === 'parallel') for (let index = 0; index < 2; index++) {
      const source = `export function parallelProbe${index}(x) { return x + ${index}; }`;
      const path = `${root}/parallel-${index}.js`; await writeFile(path, source);
      const file = { id: randomUUID(), name: `parallel-${index}.js`, uri: pathToFileURL(path).href, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS', source };
      captures.push(file); await workspace.attach(file);
    }
    await workspace.send('Run the offline fixture tool.', captures[0]?.id);
  } else if (stage.startsWith('auto-')) {
    await workspace.model(stage === 'auto-delete' ? 'deepseek' : 'test');
    if (stage === 'auto-delete') {
      summaryMode = 'slow';
      const model = await workspace.connections.manual('deepseek', { id: 'offline-delete-compaction', name: 'Offline delete compaction', contextWindow: 128000, maxTokens: 8192, thinking: ['off'] }, {}, true);
      await workspace.model(model.id);
    }
    const source = 'export function autoCompactProbe(x) { return x + 1; }';
    const path = `${root}/auto-${stage}.js`; await writeFile(path, source);
    const file = { id: randomUUID(), name: 'auto.js', uri: pathToFileURL(path).href, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS', source };
    await workspace.attach(file);
    const current = await workspace.harness.conversation(workspace.getSnapshot().active, BACKGROUND_CONTEXT);
    const count = stage === 'auto-threshold' ? 3 : 2;
    await current.commit(async (tx) => {
      for (let index = 0; index < count; index++) await tx.appendEntry(UserEntry, current.id, { model: [{ role: 'user', content: `synthetic-auto-${index}:` + 'history '.repeat(stage === 'auto-threshold' ? 25000 : 20000), timestamp: Date.now() }] });
    }, BACKGROUND_CONTEXT);
    const original = (await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id);
    await workspace.send('Query the immutable capture after automatic compaction.', file.id);
    if (stage === 'auto-delete') {
      const active = (await workspace.harness.inspect(BACKGROUND_CONTEXT)).tasks.find((task) => task.record.kind === 'pi.compaction');
      assert.ok(active?.record.background, 'a real background compaction must still be active');
      await workspace.purge(current.id);
      assert.equal(await workspace.harness.conversation(current.id, BACKGROUND_CONTEXT), undefined);
      assert.equal((await workspace.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
      assert.equal((await workspace.fileLibrary.get(file.id)).status, 'active');
    } else {
    for (const item of (await workspace.harness.snapshot(LiveDoc, current.id, BACKGROUND_CONTEXT))?.compactions ?? []) {
      const receipt = await workspace.harness.waitForTask(item.taskId, BACKGROUND_CONTEXT);
      if (receipt.state.outcome.status === 'completed' && receipt.state.outcome.result.submissionId !== undefined) await (await workspace.harness.submission(receipt.state.outcome.result.submissionId, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    }
    const entries = (await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items;
    const summary = entries.find((entry) => entry.kind === 'pi.compaction');
    assert.ok(summary);
    assert.ok(original.every((id) => entries.some((entry) => entry.id === id)));
    const task = (await workspace.harness.commit((tx) => tx.scanTasks({ conversationId: current.id, kind: 'pi.compaction' }, 128), BACKGROUND_CONTEXT)).items.at(-1);
    assert.equal(task.input.reason, 'threshold');
    assert.equal(!!task.background, stage === 'auto-background');
    assert.ok((await current.context(BACKGROUND_CONTEXT)).head);
    assert.ok((await workspace.refresh()).turns.at(-1).tools[0].text.includes('autoCompactProbe'));
    }
  } else if (stage === 'recover' || stage === 'reopen') {
    await workspace.harness.waitForIdle(BACKGROUND_CONTEXT);
  } else if (stage === 'compact') {
    assert.equal((await workspace.compact()).compacted, false);
    const current = await workspace.harness.conversation(workspace.getSnapshot().active, BACKGROUND_CONTEXT);
    await current.commit(async (tx) => {
      for (let index = 0; index < 3; index++) await tx.appendEntry(UserEntry, current.id, { model: [{ role: 'user', content: `synthetic-history-${index}:` + 'history '.repeat(14000), timestamp: Date.now() }] });
    }, BACKGROUND_CONTEXT);
    const before = (await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id);
    summaryMode = 'error';
    await assert.rejects(workspace.compact(), /压缩|compaction/i);
    assert.ok((await workspace.refresh()).compactionError);
    summaryMode = 'slow';
    const cancelled = workspace.compact();
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await workspace.refresh()).compactions.length) break;
      await delay(20);
    }
    await workspace.cancelCompaction();
    assert.equal((await cancelled).cancelled, true);
    summaryMode = 'ok';
    const result = await workspace.compact();
    assert.equal(result.compacted, true);
    assert.equal(result.snapshot.compactionError, null);
    const after = await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT);
    assert.ok(before.every((id) => after.items.some((entry) => entry.id === id)));
    assert.ok(after.items.some((entry) => entry.kind === 'pi.compaction'));
    assert.ok(summaryLimits.length >= 2 && summaryLimits.every((limit) => limit > 2048));
  }
  if (stage === 'cancel') { assert.ok(stop); await stop; }
  const snapshot = await workspace.refresh();
  const turn = snapshot.turns.at(-1);
  if (stage === 'cancel' || stage === 'reopen-stopped') {
    assert.equal(turn.status, 'stopped');
    assert.ok(turn.endedAt >= turn.startedAt);
  } else if (stage !== 'compact' && !stage.startsWith('auto-') && !turn.prompt.startsWith('Query the immutable capture')) {
    assert.equal(turn.status, 'done');
    assert.ok(turn.tools[0].durationMs > 0);
    assert.ok(turn.endedAt >= turn.startedAt);
    assert.ok(turn.activities.some((block) => block.kind === 'thinking' && block.text.includes('Offline fixture')));
    assert.ok(turn.activities.some((block) => block.kind === 'tool' && (block.result?.text.includes('second-output-✓') || block.result?.text.includes('parallelProbe'))));
  }
  if (stage === 'run') for (const phase of ['thinking', 'answer', 'tool', 'live-tool', 'live-output']) assert.ok(seen.has(phase), `Missing ${phase}`);
  if (stage === 'parallel') {
    // shell is sequential: two calls from one response stay separate activities with their own durations.
    const tools = turn.activities.filter((block) => block.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.ok(tools.every((block) => block.state === 'done' && block.result?.durationMs > 0));
  }
  if (stage === 'rounds') {
    assert.ok(seen.has('queue'));
    assert.deepEqual(turn.activities.filter((block) => block.kind === 'tool').map((block) => block.state), ['error', 'done', 'done']);
  }
  if (stage === 'recover') assert.ok(turn.timing.incomplete);
  console.log(JSON.stringify({ snapshot, seen: [...seen], summaryLimits }));
} finally { unsubscribe(); await workspace.close(); }
