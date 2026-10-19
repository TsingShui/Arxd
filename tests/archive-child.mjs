import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
const [stage, database, binary] = process.argv.slice(2), root = dirname(database), statePath = join(root, 'archive.json');
await mkdir(join(root, 'home'), { recursive: true });
const jobs = new Map(); const host = await createHost(binary, undefined, { root, jobs, previews: new Map() });
const core = await openWorkspace(openDatabase(database), host);
try {
  if (stage === 'seed') {
    const source = 'export function archiveContractProbe(value) { return value + 17; }'; const path = join(root, 'ArchiveFixtureUnique.js'); await writeFile(path, source);
    const file = { id: randomUUID(), name: 'ArchiveFixtureUnique.js', uri: pathToFileURL(path).href, source, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS' };
    await core.model('test');
    await core.attach(file); await core.send('ArchiveFixtureUnique', file.id);
    const before = core.getSnapshot(), id = before.active;
    await core.archive(id, true); assert.equal(core.getSnapshot().conversations.find((row) => row.id === id).archived, true);
    assert.deepEqual(core.getSnapshot().turns, before.turns); assert.deepEqual(core.getSnapshot().files, before.files);
    assert.equal((await core.search('ArchiveFixtureUnique', null, 'active')).length, 0);
    assert.equal((await core.search('ArchiveFixtureUnique', null, 'archived'))[0].archived, true);
    assert.ok((await core.search('ArchiveFixtureUnique')).every((group) => group.hits.every((hit) => !hit.text.includes('<arxd-'))));
    assert.equal((await core.search('arxd-workspace')).length, 0);
    await core.select(null); await core.select(id);
    assert.equal(core.getSnapshot().conversations.find((row) => row.id === id).archived, true);
    const Metadata = defineDoc({ kind: 'arxd.conversation', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ title: '', updatedAt: 0, files: [] }) });
    await core.harness.commit(async (tx) => { (await tx.doc(Metadata, id)).model = 'unavailable-model'; }, BACKGROUND_CONTEXT);
    await assert.rejects(core.send('Should not restore on failed admission'), /模型/);
    assert.equal((await core.refresh()).conversations.find((row) => row.id === id).archived, true);
    await core.model('test');
    await writeFile(statePath, JSON.stringify({ id, file, turns: core.getSnapshot().turns }));
  } else {
    await core.model('test');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(core.getSnapshot().active, state.id); assert.deepEqual(core.getSnapshot().turns, state.turns);
    assert.equal(core.getSnapshot().conversations.find((row) => row.id === state.id).archived, true);
    await core.send('New input restores the archived conversation.', state.file.id);
    assert.equal(core.getSnapshot().conversations.find((row) => row.id === state.id).archived, false);
    assert.equal(core.getSnapshot().active, state.id);
    await core.archive(state.id, true); await core.archive(state.id, false);
    assert.equal((await core.fileLibrary.get(state.file.id)).status, 'active');
    await core.select(null); const running = core.send('运行 Shell 停止验证');
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { const value = await core.refresh(); ready = value.turns.at(-1)?.activities.some((block) => block.kind === 'tool' && block.output?.includes('cancellation probe started')); if (ready) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.ok(ready && jobs.size === 1);
    const active = core.getSnapshot().active;
    await core.archive(active, true); assert.equal(core.getSnapshot().busy, true); assert.equal(jobs.size, 1);
    await core.select(null); await core.select(active); assert.equal(core.getSnapshot().conversations.find((row) => row.id === active).archived, true);
    await core.stop(); await running; assert.equal(jobs.size, 0);
    assert.equal(core.getSnapshot().conversations.find((row) => row.id === active).archived, true);
  }
  console.log(JSON.stringify({ verified: true, stage }));
} finally { await core.close(); }
