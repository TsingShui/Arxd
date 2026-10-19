import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const workspace = await openWorkspace(openDatabase(database), await createHost(binary));
try {
  await workspace.harness.waitForIdle(BACKGROUND_CONTEXT);
  if (stage === 'seed' || stage === 'second' || stage === 'invalid') {
    await workspace.select(null); await workspace.model('test');
    const name = stage === 'second' ? 'secondEntry' : 'firstEntry';
    const source = `export function ${name}(value) { return value + 2; }\n`;
    const file = { id: randomUUID(), name: `${name}.js`, source, size: Buffer.byteLength(source),
      sha256: stage === 'invalid' ? '0'.repeat(64) : createHash('sha256').update(source).digest('hex'),
      uri: 'file:///host-fixture.js', format: 'JS' };
    await workspace.attach(file);
    await workspace.send(`Query ${name}`, file.id);
    if (stage === 'seed') await workspace.palette('spring');
  } else if (stage === 'select-first') {
    const current = workspace.getSnapshot();
    const first = current.conversations.find((c) => c.title === 'Query firstEntry');
    assert.ok(first);
    await workspace.select(first.id);
  }
  const snapshot = await workspace.refresh();
  const last = snapshot.turns.at(-1);
  console.log(JSON.stringify({ ...snapshot, report: last ? workspace.report(last.id)?.content ?? null : null }));
} finally { await workspace.close(); }
