import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
const [stage, path, binary] = process.argv.slice(2), root = dirname(path), statePath = join(root, 'delete.json');
await mkdir(join(root, 'home'), { recursive: true });
const jobs = new Map(); const host = await createHost(binary, undefined, { root, jobs, previews: new Map() });
host.files = {
  save: async (name, source) => { const id = randomUUID(), destination = join(root, id); await writeFile(destination, source); return { id, name, uri: pathToFileURL(destination).href, size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), source: name.endsWith('.js') ? source : null, format: name.endsWith('.js') ? 'JS' : 'MD' }; },
  capture: async () => { throw new Error('Unused'); }, remove: async () => { throw new Error('Conversation deletion must not remove files'); },
};
let database = openDatabase(path);
if (stage === 'erase-crash') {
  const actual = database;
  database = new Proxy(actual, { get(target, key) {
    if (key === 'transaction') return (callback) => actual.transaction((tx) => callback(new Proxy(tx, { get(inner, method) { if (method === 'exec') return async (sql) => { await inner.exec(sql); if (sql.startsWith('DELETE FROM document_revisions WHERE document_id IN')) { process.send?.({ stage, gate: true }); await new Promise(() => {}); } }; return Reflect.get(inner, method); } })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const core = await openWorkspace(database, host);
const Preferences = defineDoc({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ active: null, conversations: [] }) });
async function referencesGone(id) { const prefs = await core.harness.snapshot(Preferences, BACKGROUND_CONTEXT); assert.ok(prefs && !prefs.conversations.includes(id) && prefs.active !== id, 'Materialized preferences retain no erased conversation reference'); }
const raw = new DatabaseSync(path, { readOnly: true });
let state = stage === 'seed' ? {} : JSON.parse(await readFile(statePath, 'utf8'));
try {
  if (stage === 'seed') {
    const file = await host.files.save('KeepSharedDelete.js', 'export function keepDeletionFile(x) { return x + 18; }');
    await core.model('test');
    await core.attach(file); await core.send('DeleteVictimUnique', file.id);
    const first = core.getSnapshot().active; const saved = await core.saveArtifact(core.getSnapshot().artifacts[0].id);
    await core.archive(first, true);
    await core.select(null); await core.attachExisting(file.id); await core.send('UnrelatedSurvivorUnique', file.id);
    state = { first, survivor: core.getSnapshot().active, file, saved, survivorTurns: core.getSnapshot().turns };
    await writeFile(join(root, 'home', 'user-runtime-file'), 'preserved'); await writeFile(statePath, JSON.stringify(state));
  } else if (stage === 'purge' || stage === 'reopen') {
    const fileLibrary = core.fileLibrary;
    if (stage === 'purge') {
      const records = raw.prepare("SELECT id FROM entries WHERE conversation_id = ? UNION SELECT id FROM tasks WHERE conversation_id = ? UNION SELECT id FROM submissions WHERE conversation_id = ? UNION SELECT id FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?").all(state.first, state.first, state.first, state.first);
      const skills = core.skills, scan = skills.scanStatus;
      assert.equal(typeof scan()?.then, 'undefined');
      let skillEvents = 0; const offSkills = skills.subscribe(() => skillEvents++); assert.equal(typeof offSkills, 'function');
      let updates = 0; const off = core.subscribe(() => updates++); await core.purge(state.first); await core.refresh(); assert.ok(updates > 0); off();
      assert.equal(skillEvents, 1, 'A retained skill subscription rebinds once across purge'); offSkills();
      assert.equal(typeof scan()?.then, 'undefined');
      for (const { id } of records) assert.equal(raw.prepare('SELECT id FROM record_ids WHERE id = ?').get(id), undefined);
    }
    await referencesGone(state.first);
    assert.equal(await core.harness.conversation(state.first, BACKGROUND_CONTEXT), undefined); await assert.rejects(core.select(state.first), /不存在/);
    assert.equal((await core.search('DeleteVictimUnique')).length, 0); assert.ok(!core.getSnapshot().conversations.some((row) => row.id === state.first));
    await core.select(state.survivor); assert.deepEqual(core.getSnapshot().turns, state.survivorTurns);
    for (const file of [state.file, state.saved]) { assert.equal((await fileLibrary.get(file.id)).status, 'active'); assert.equal(createHash('sha256').update(await readFile(fileURLToPath(file.uri))).digest('hex'), file.sha256); }
    assert.equal((await fileLibrary.usage(state.file.id)).length, 1); assert.equal(await readFile(join(root, 'home', 'user-runtime-file'), 'utf8'), 'preserved');
    assert.equal(raw.prepare('SELECT count(*) AS n FROM document_revisions r LEFT JOIN documents d ON d.id = r.document_id WHERE d.id IS NULL').get().n, 0); assert.equal(core.getSnapshot().deletions.length, 0);
  } else if (stage === 'retry') {
    await core.select(null); const unrelated = core.send('运行 Shell 停止验证'); unrelated.catch(() => {});
    for (let attempt = 0; attempt < 200 && !jobs.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(jobs.size, 1);
    await assert.rejects(core.purge(state.first), /其他会话仍在运行/);
    assert.equal(jobs.size, 1, 'purge must not cancel unrelated shell work');
    await core.stop(); await unrelated; assert.equal(jobs.size, 0);
    await core.select(state.survivor);
    await database.exec(`CREATE TRIGGER reject_purge BEFORE DELETE ON conversations WHEN OLD.id = ${state.first} BEGIN SELECT RAISE(ABORT, 'injected erasure failure'); END`);
    await assert.rejects(core.purge(state.first), /injected erasure failure/);
    assert.ok(await core.harness.conversation(state.first, BACKGROUND_CONTEXT));
    assert.equal(core.getSnapshot().deletions[0].id, state.first);
    await assert.rejects(core.select(state.first), /正在删除/);
    assert.equal((await core.search('DeleteVictimUnique')).length, 0);
    await core.select(state.survivor); assert.deepEqual(core.getSnapshot().turns, state.survivorTurns);
    await database.exec('DROP TRIGGER reject_purge'); await core.purge(state.first);
    assert.equal(core.getSnapshot().deletions.length, 0);
    const version = raw.prepare('SELECT version FROM durable_schema').get().version;
    await database.run('UPDATE durable_schema SET version = 99');
    await assert.rejects(core.purge(state.survivor), /版本/);
    assert.ok(await core.harness.conversation(state.survivor, BACKGROUND_CONTEXT));
    await database.run('UPDATE durable_schema SET version = ?', version);
  } else if (stage === 'running' || stage === 'intent-crash' || stage === 'close-running') {
    await core.select(null); const running = core.send('运行 Shell 停止验证'); running.catch(() => {});
    for (let attempt = 0; attempt < 200 && !jobs.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(jobs.size, 1); const id = core.getSnapshot().active;
    if (stage === 'intent-crash') { state.crash = id; await writeFile(statePath, JSON.stringify(state)); await database.run('INSERT INTO arxd_conversation_deletions VALUES (?, ?, NULL)', id, Date.now()); process.send?.({ gate: true, stage, pid: [...jobs.values()][0].pid }); await new Promise(() => {}); }
    if (stage === 'close-running') { await core.close(); await running.catch(() => undefined); assert.equal(jobs.size, 0); }
    else { await core.purge(id); await referencesGone(id); assert.equal(core.getSnapshot().active, null); await running; assert.equal(jobs.size, 0); assert.equal(await core.harness.conversation(id, BACKGROUND_CONTEXT), undefined); await core.select(state.survivor); assert.deepEqual(core.getSnapshot().turns, state.survivorTurns); }
  } else if (stage === 'forks') {
    await core.select(null); await core.send('ForkParentUnique'); const id = core.getSnapshot().active;
    const current = await core.harness.conversation(id, BACKGROUND_CONTEXT), at = (await current.entries({ order: 'ascending' }, 1, undefined, BACKGROUND_CONTEXT)).items[0].id;
    const fork = await current.fork(at, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    await assert.rejects(core.purge(id), /分支/); assert.ok(await core.harness.conversation(id, BACKGROUND_CONTEXT)); assert.equal(core.getSnapshot().deletions.length, 0);
    await core.purge(fork.id); await core.purge(id); await core.select(state.survivor);
  } else if (stage === 'erase-crash') { await core.purge(state.first); throw new Error('Did not reach erasure gate');
  } else if (stage === 'recover') {
    const id = state.crash ?? state.first; assert.equal(await core.harness.conversation(id, BACKGROUND_CONTEXT), undefined); assert.equal(raw.prepare('SELECT id FROM conversations WHERE id = ?').get(id), undefined); assert.equal(core.getSnapshot().deletions.length, 0);
    assert.equal((await core.fileLibrary.get(state.file.id)).status, 'active'); await core.select(state.survivor); assert.deepEqual(core.getSnapshot().turns, state.survivorTurns);
  }
  console.log(JSON.stringify({ verified: true, stage }));
} finally { raw.close(); await core.close(); }
