import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { openAgentRuntime } from '../src/agent/runtime.ts';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const root = dirname(database);
await mkdir(join(root, 'captures'), { recursive: true });
const statePath = join(root, 'scenario.json');
const host = await createHost(binary);
host.files = {
  save: async (name, source) => {
    const id = randomUUID();
    const path = join(root, 'captures', id + '.bin');
    const bytes = Buffer.from(source);
    await writeFile(path, bytes);
    return { id, name, uri: pathToFileURL(path).href, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: name.endsWith('.js') ? 'JS' : 'MD', source: name.endsWith('.js') && bytes.length <= 4096 ? source : null };
  },
  capture: async () => { throw new Error('Not used by catalog checks'); },
  remove: async (file) => { try { await unlink(fileURLToPath(file.uri)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
};

if (stage === 'legacy-build') {
  const { harness } = await openAgentRuntime(openDatabase(database), host);
  const Preferences = defineDoc({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ palette: 'fire', active: null, conversations: [] }) });
  const Metadata = defineDoc({ kind: 'arxd.conversation', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ title: '', updatedAt: 0, files: [] }) });
  const imported = await host.files.save('旧附件-✓.js', 'export function legacyProbe(x) { return x; }');
  const detached = await host.files.save('未列出的附件.js', 'export function detachedProbe(x) { return x; }');
  try {
    const ids = [];
    for (const [index, file] of [imported, detached].entries()) {
      const current = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } }, init: async (tx, id) => {
        const meta = await tx.doc(Metadata, id); meta.title = index ? 'Detached legacy' : 'Visible legacy'; meta.files = [file];
        if (!index) { const prefs = await tx.doc(Preferences); prefs.active = id; prefs.conversations = [id]; }
      } }, BACKGROUND_CONTEXT);
      ids.push(current.id);
    }
    await writeFile(statePath, JSON.stringify({ imported, detached, ids }));
    console.log(JSON.stringify({ builtLegacy: true }));
  } finally { await harness.close(BACKGROUND_CONTEXT); }
} else {
  const workspace = await openWorkspace(openDatabase(database), host);
  try {
    await workspace.harness.waitForIdle(BACKGROUND_CONTEXT);
    if (stage === 'legacy-reopen') {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const page = await workspace.fileLibrary.list();
      assert.equal(page.files.length, 2);
      assert.ok(page.files.some((row) => row.file.id === state.detached.id));
      assert.equal((await workspace.fileLibrary.usage(state.detached.id))[0].listed, false);
      await workspace.model('test');
      await workspace.attachExisting(state.detached.id);
      await workspace.send('Query the migrated immutable input.', state.detached.id);
      assert.ok(workspace.getSnapshot().turns.at(-1).tools[0].text.includes('detachedProbe'));
    } else if (stage === 'seed') {
      const file = await host.files.save('共享证据.js', 'export function sharedFileProbe(x) { return x + 7; }');
      await workspace.model('test');
      await workspace.fileLibrary.remember(file);
      assert.equal(workspace.getSnapshot().active, null);
      await workspace.attachExisting(file.id);
      await workspace.send('Query the shared input.', file.id);
      const first = workspace.getSnapshot().active;
      const artifact = workspace.report(workspace.getSnapshot().turns.at(-1).id);
      assert.ok(artifact, 'Report is assembled on demand');
      const saved = await workspace.saveReport(artifact.turnId);
      assert.equal((await workspace.saveReport(artifact.turnId)).id, saved.id);
      await workspace.select(null); await workspace.attachExisting(file.id);
      const second = workspace.getSnapshot().active;
      await workspace.fileLibrary.rename(file.id, '重命名后-✓.js');
      assert.equal(workspace.getSnapshot().files[0].name, '重命名后-✓.js');
      assert.equal(workspace.getSnapshot().files[0].sha256, file.sha256);
      assert.equal((await workspace.fileLibrary.usage(file.id)).length, 2);
      await workspace.forget(first);
      assert.equal((await workspace.fileLibrary.get(file.id)).status, 'active');
      assert.ok((await readFile(fileURLToPath(file.uri))).length);
      await writeFile(statePath, JSON.stringify({ file, saved, first, second }));
    } else if (stage === 'delete-crash') {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const remove = host.files.remove;
      host.files.remove = async (file) => {
        await remove(file);
        console.log(JSON.stringify({ checkpoint: true }));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      };
      await workspace.fileLibrary.remove(state.file.id);
    } else if (stage === 'delete-reopen') {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal((await workspace.fileLibrary.get(state.file.id)).status, 'deleted');
      assert.equal((await workspace.fileLibrary.get(state.saved.id)).status, 'active');
      assert.equal(workspace.getSnapshot().files[0].available, false);
      await assert.rejects(workspace.attachExisting(state.file.id), /删除/);
      await assert.rejects(workspace.send('Do not use deleted bytes.', state.file.id), /附件/);
      const original = await workspace.harness.conversation(state.first, BACKGROUND_CONTEXT);
      const entries = await original.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT);
      assert.ok(entries.items.some((entry) => entry.kind === 'pi.tool-result'));
      const saved = await readFile(fileURLToPath(state.saved.uri));
      assert.equal(createHash('sha256').update(saved).digest('hex'), state.saved.sha256);
    }
    console.log(JSON.stringify({ snapshot: await workspace.refresh(), library: await workspace.fileLibrary.list() }));
  } finally { await workspace.close(); }
}
