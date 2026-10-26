import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { appendActivity, parseRecords, parseShellOutput, projectTurns, textOf } from '../src/workspace/turns.ts';

const text = (value) => ({ type: 'text', text: value });
const call = (id, name = 'shell') => ({ type: 'toolCall', id, name, arguments: { script: id } });
const user = (content = 'Question', timestamp = 100) => ({ role: 'user', content, timestamp });
const assistant = (content, overrides = {}) => ({
  role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture-model',
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
  stopReason: 'stop', timestamp: 200, ...overrides,
});
const toolResult = (id, overrides = {}) => ({
  role: 'toolResult', toolCallId: id, toolName: 'shell', content: [text('plain shell output')],
  timestamp: 210, ...overrides,
});
const entry = (id, kind, messages, overrides = {}) => ({ id, kind: kind.kind, conversationId: 'chat', model: messages, ...overrides });
const options = { files: [], modelLabel: 'Selected model', responseLabel: (provider, model) => `${provider}/${model}` };
// Fixtures are chronological for readability; storage pages are descending.
const project = (entries, overrides = {}) => projectTurns(entries.toReversed(), { ...options, ...overrides });

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('text extraction and JSONL records keep text and objects, not images, arrays or malformed lines', () => {
  assert.equal(textOf('unchanged\ntext'), 'unchanged\ntext');
  assert.equal(textOf([text('first'), { type: 'image', data: 'image', mimeType: 'image/png' }, text('second')]), 'first\nsecond');
  assert.equal(textOf([]), '');
  assert.deepEqual(parseRecords(' \n{"name":"entry"}\ninvalid\n[]\nnull\n1\n"text"\nfalse\n{}\n'), [{ name: 'entry' }, {}]);
  assert.deepEqual(parseRecords(''), []);
  assert.deepEqual(parseShellOutput(JSON.stringify({ exitCode: 0, stdout: '{"name":"entry"}\nnot json\n' })), [{ name: 'entry' }]);
  assert.deepEqual(parseShellOutput('{"name":"direct"}\n'), [{ name: 'direct' }]);
});

test('projection preserves chronological turns and resolves captured files without mutating stored entries', () => {
  const file = { id: 'a1-b2', name: 'input.js' };
  const entries = freeze([
    entry(1, UserEntry, [user('Question\n\n<arxd-workspace>\n<arxd-file id="a1-b2"/>\n</arxd-workspace>')]),
    entry(2, AssistantEntry, [assistant([text('Answer')], { durationMs: 50 })], { byTaskId: 'generation-1' }),
    entry(3, UserEntry, [user([text('Next question')], 300)]),
  ]);
  const before = structuredClone(entries);
  const { turns, lastModelTasks } = project(entries, { files: freeze([file]) });
  assert.deepEqual(turns.map((turn) => [turn.id, turn.prompt, turn.status]), [['1', 'Question', 'done'], ['3', 'Next question', 'stopped']]);
  assert.equal(turns[0].file, file);
  assert.equal(turns[1].file, null);
  assert.equal(turns[0].answer, 'Answer');
  assert.equal(turns[0].startedAt, 100);
  assert.equal(turns[0].endedAt, 250);
  assert.equal(turns[0].modelLabel, 'fixture/fixture-model');
  assert.equal(turns[1].modelLabel, 'Selected model');
  assert.deepEqual(lastModelTasks.get(turns[0]), { id: 'generation-1', conversationId: 'chat' });
  assert.deepEqual(entries, before);
  assert.deepEqual(project(entries, { files: [file] }).turns, turns);
});

test('partial history ignores orphan results, missing user messages, hidden prompts and compaction summaries', () => {
  const { turns } = project([
    entry(1, AssistantEntry, [assistant([text('outside page')])]),
    entry(2, ToolResultEntry, [toolResult('orphan')]),
    entry(3, UserEntry, undefined),
    entry(4, UserEntry, [user('hidden')]),
    entry(5, CompactionEntry, [user('summary')]),
    entry(6, UserEntry, [user('visible')]),
    entry(7, AssistantEntry, [user('not an assistant')]),
  ], { hiddenTurns: ['4'] });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, 'visible');
  assert.deepEqual(turns[0].activities, []);
});

test('retries retain partial text, request errors and the latest owning generation while accumulating usage', () => {
  const failure = { id: 'request', attempt: 1, stage: 'generation', deadlineAt: 500,
    category: 'network', message: 'Connection reset', retryable: true };
  const { turns, lastModelTasks } = project([
    entry(1, UserEntry, [user()]),
    entry(2, AssistantEntry, [assistant([text('partial')], { stopReason: 'error', arxdFailure: failure })], { byTaskId: 'attempt-1' }),
    entry(3, AssistantEntry, [assistant([text('recovered')], { timestamp: 300 })], { byTaskId: 'attempt-2' }),
  ]);
  const [turn] = turns;
  assert.equal(turn.status, 'done');
  assert.equal(turn.answer, 'recovered');
  assert.equal(turn.tokens, 10);
  assert.equal(turn.cost, 0.6);
  assert.deepEqual(turn.requestErrors, [failure]);
  assert.deepEqual(turn.activities.map((block) => block.kind), ['text', 'request-error', 'text']);
  assert.deepEqual(turn.activities[1], { kind: 'request-error', id: 'attempt-1/200/error', failure, partial: true });
  assert.deepEqual(lastModelTasks.get(turn), { id: 'attempt-2', conversationId: 'chat' });
});

test('terminal reasons and tool errors preserve existing turn status and error-message fallback rules', () => {
  for (const [reason, status] of [['stop', 'done'], ['error', 'failed'], ['aborted', 'stopped'], ['length', 'failed'], ['toolUse', 'stopped']]) {
    const { turns: [turn] } = project([
      entry(1, UserEntry, [user()]),
      entry(2, AssistantEntry, [assistant([], { stopReason: reason, errorMessage: 'Provider error' })]),
    ]);
    assert.equal(turn.status, status, reason);
    assert.equal(turn.answer, reason === 'toolUse' ? '' : 'Provider error', reason);
    assert.equal(turn.endedAt, undefined);
  }
  const { turns: [failedTool] } = project([
    entry(1, UserEntry, [user()]),
    entry(2, ToolResultEntry, [toolResult('missing-call', { isError: true })]),
    entry(3, AssistantEntry, [assistant([text('Tool failed')])]),
  ]);
  assert.equal(failedTool.status, 'failed');
  const { turns: [networkError] } = project([
    entry(1, UserEntry, [user()]),
    entry(2, AssistantEntry, [assistant([], { stopReason: 'error', errorMessage: 'Network error', arxdFailure: { category: 'network' } })]),
  ]);
  assert.equal(networkError.answer, '', 'request failures are activity blocks, not duplicate answer text');
  assert.equal(networkError.activities[0].partial, false);
});

test('parallel and repeated tool calls match the last unresolved activity and preserve durations and arguments', () => {
  const { turns: [turn] } = project([
    entry(1, UserEntry, [user()]),
    entry(2, AssistantEntry, [assistant([call('a'), call('b', 'shell')], { stopReason: 'toolUse' })]),
    entry(3, ToolResultEntry, [toolResult('b', { toolName: 'shell', durationMs: 12 })], { byTaskId: 'tool-b' }),
    entry(4, ToolResultEntry, [toolResult('a', { durationMs: 34, content: [text(JSON.stringify({ exitCode: 0, stdout: '{"name":"entry"}\n' }))] })], { byTaskId: 'tool-a' }),
    entry(5, AssistantEntry, [assistant([call('a')], { stopReason: 'toolUse', timestamp: 300 })]),
    entry(6, ToolResultEntry, [toolResult('a', { isError: true })], { byTaskId: 'tool-a-repeated', data: { diagnostics: [{ code: 'interrupted' }] } }),
  ]);
  const blocks = turn.activities.filter((block) => block.kind === 'tool');
  assert.deepEqual(blocks.map((block) => [block.callId, block.state, block.timingKey]), [
    ['a', 'done', 'tool:tool-a'], ['b', 'done', 'tool:tool-b'], ['a', 'stopped', 'tool:tool-a-repeated'],
  ]);
  assert.deepEqual(turn.calls, [{ id: 'a', name: 'shell' }, { id: 'b', name: 'shell' }, { id: 'a', name: 'shell' }]);
  assert.deepEqual(turn.tools.map((tool) => tool.durationMs), [12, 34, undefined]);
  assert.deepEqual(turn.tools.map((tool) => tool.records), [[], [{ name: 'entry' }], []]);
  for (const block of blocks) assert.equal(block.result.arguments, block.arguments);
});

test('tool activity distinguishes ordinary errors from interruption diagnostics and keeps unmatched results', () => {
  for (const [code, state] of [['invalid-input', 'error'], ['aborted', 'stopped'], ['interrupted', 'stopped']]) {
    const { turns: [turn] } = project([
      entry(1, UserEntry, [user()]),
      entry(2, AssistantEntry, [assistant([call('a')], { stopReason: 'toolUse' })]),
      entry(3, ToolResultEntry, [toolResult('a', { isError: true })], { data: { diagnostics: [{ code }] } }),
      entry(4, ToolResultEntry, [toolResult('unmatched')]),
    ]);
    assert.equal(turn.activities[0].state, state);
    assert.equal(turn.activities[0].timingKey, 'tool:2/200/0');
    assert.equal(turn.tools.length, 2);
    assert.deepEqual(turn.tools[0].records, []);
    assert.equal(turn.tools[1].arguments, undefined);
  }
});

test('live activities hide redacted reasoning and mark only the trailing thinking block as live', () => {
  const turn = { activities: [] };
  appendActivity(turn, assistant([
    { type: 'thinking', thinking: 'must stay hidden', redacted: true },
    text('answer'),
    { type: 'thinking', thinking: 'current thought' },
  ]), 'live-request', true);
  assert.deepEqual(turn.activities, [
    { kind: 'thinking', id: 'live-request/0', timingKey: 'live-request/0', text: '', live: false },
    { kind: 'text', id: 'live-request/1', text: 'answer' },
    { kind: 'thinking', id: 'live-request/2', timingKey: 'live-request/2', text: 'current thought', live: true },
  ]);
});
