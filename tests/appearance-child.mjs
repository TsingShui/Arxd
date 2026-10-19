import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
const [stage, database, binary] = process.argv.slice(2);
const statePath = join(dirname(database), 'appearance-state.json');
// The capacity projection is live; only durable fields must survive a reopen.
const durable = ({ capacity, ...snapshot }) => snapshot;
const core = await openWorkspace(openDatabase(database), await createHost(binary));
try {
  if (stage === 'seed') {
    assert.equal(core.getSnapshot().appearance, 'system'); assert.equal(core.getSnapshot().motion, 'system');
    const source = 'export function appearanceFixture(value) { return value + 7; }'; const path = join(dirname(database), 'appearance.js'); await writeFile(path, source);
    const file = { id: randomUUID(), name: 'appearance.js', uri: pathToFileURL(path).href, source, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS' };
    await core.model('test'); await core.attach(file); await core.send('Query the appearance fixture.', file.id);
    const before = core.getSnapshot();
    await core.appearance('light'); await core.theme('spring'); await core.appearance('dark');
    assert.equal(core.getSnapshot().palette, 'spring'); assert.equal(core.getSnapshot().appearance, 'dark');
    await Promise.all([core.appearance('light'), core.appearance('system'), core.theme('fire'), core.theme('spring'), core.motion('reduced')]);
    const after = core.getSnapshot();
    assert.equal(after.appearance, 'system'); assert.equal(after.palette, 'spring'); assert.equal(after.motion, 'reduced');
    for (const key of ['active', 'model', 'thinking', 'files', 'turns']) assert.deepEqual(after[key], before[key]);
    await assert.rejects(core.appearance('invalid')); await assert.rejects(core.theme('invalid')); await assert.rejects(core.motion('invalid'));
    await writeFile(statePath, JSON.stringify(after));
  } else if (stage === 'reopen') {
    await core.model('test');
    const previous = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(durable(core.getSnapshot()), durable(previous));
  } else if (stage === 'legacy') {
    const Preferences = defineDoc({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ palette: 'fire', active: null, conversations: [] }) });
    for (const palette of ['fire', 'spring']) {
      await core.harness.commit(async (tx) => { const value = await tx.doc(Preferences); value.palette = palette; delete value.appearance; delete value.motion; }, BACKGROUND_CONTEXT);
      const snapshot = await core.refresh();
      assert.equal(snapshot.appearance, palette === 'fire' ? 'dark' : 'light'); assert.equal(snapshot.motion, 'system');
    }
    await writeFile(statePath, JSON.stringify(core.getSnapshot()));
  } else {
    const previous = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(durable(core.getSnapshot()), durable(previous)); assert.equal(core.getSnapshot().appearance, 'light');
  }
  console.log(JSON.stringify({ verified: true, stage }));
} finally { await core.close(); }
