import assert from 'node:assert/strict';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const host = await createHost(binary);
// The default DeepSeek Flash model supports off/low/high/max; only the
// credential gate needs a configured connection, no request is sent.
host.credentials = { get: async () => ({ apiKey: 'thinking-fixture-key' }), put: async () => undefined, remove: async () => undefined };
const core = await openWorkspace(openDatabase(database), host);
try {
  if (stage === 'seed') {
    assert.equal(core.getSnapshot().thinking, 'off');
    await core.model('deepseek');
    assert.equal(core.getSnapshot().thinking, 'off');
    await core.thinking('max');
    assert.equal(core.getSnapshot().thinking, 'max');

    // A model without a remembered level falls back to its own first level; the
    // choice for the previous model must come back when it is selected again.
    await core.model('test');
    assert.equal(core.getSnapshot().thinking, 'off');
    await core.model('deepseek');
    assert.equal(core.getSnapshot().thinking, 'max');

    await core.thinking('high');
    await core.model('test');
    await core.model('deepseek');
    assert.equal(core.getSnapshot().thinking, 'high');
  } else if (stage === 'reopen') {
    // A fresh process restores the last explicit choice.
    assert.equal(core.getSnapshot().model, 'deepseek');
    assert.equal(core.getSnapshot().thinking, 'high');
    await core.thinking('low');
    assert.equal(core.getSnapshot().thinking, 'low');
  } else if (stage === 'reopen-low') {
    assert.equal(core.getSnapshot().model, 'deepseek');
    assert.equal(core.getSnapshot().thinking, 'low');
    // A new conversation inherits the cached level, and a model switch keeps it.
    await core.select(null);
    assert.equal(core.getSnapshot().thinking, 'low');
    await core.model('test');
    assert.equal(core.getSnapshot().thinking, 'off');
    await core.model('deepseek');
    assert.equal(core.getSnapshot().thinking, 'low');
  } else throw new Error(`Unknown stage: ${stage}`);
  console.log(JSON.stringify({ verified: true, stage }));
} finally { await core.close(); }
