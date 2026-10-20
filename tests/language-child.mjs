import assert from 'node:assert/strict';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const core = await openWorkspace(openDatabase(database), await createHost(binary));
try {
  const before = core.getSnapshot();
  if (stage === 'seed') {
    assert.equal(before.language, 'system');
    await core.model('test');
    await core.send('Language preference fixture; deterministic provider, no live request.');
    const conversation = core.getSnapshot();
    await core.language('en');
    assert.equal(core.getSnapshot().language, 'en');
    for (const key of ['active', 'files', 'turns', 'palette', 'appearance', 'motion']) assert.deepEqual(core.getSnapshot()[key], conversation[key], key);
    await assert.rejects(core.language('invalid'), /语言/);
    assert.equal(core.getSnapshot().language, 'en');
  } else if (stage === 'reopen-en') {
    assert.equal(before.language, 'en');
    assert.equal(before.turns.length, 1);
    await core.language('zh');
  } else if (stage === 'reopen-zh') {
    assert.equal(before.language, 'zh');
    assert.equal(before.turns.length, 1);
    await core.language('system');
  } else if (stage === 'reopen-system') {
    assert.equal(before.language, 'system');
    assert.equal(before.turns.length, 1);
  } else throw new Error('Unknown language stage');
  console.log(JSON.stringify({ verified: true, stage, active: core.getSnapshot().active, language: core.getSnapshot().language }));
} finally { await core.close(); }
