import { requireVerification } from './access';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';

/** Deletes only fixtures created here, retaining their independently saved files. */
export async function verifyDeletion(core: Workspace) {
  requireVerification();
  const before = core.getSnapshot(); const checks: string[] = [];
  if (before.busy || before.compactions.length) throw new Error('Finish current work before deletion verification');
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const token = globalThis.crypto.randomUUID().slice(0, 8);
  let running: ReturnType<Workspace['send']> | undefined;
  let job: typeof before.active = null;
  await core.select(null); await core.model('test');
  try {
    running = core.send('运行 Shell 停止验证'); void running.catch(() => undefined);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { ready = (await core.refresh()).turns.at(-1)?.activities.some((block) => block.kind === 'tool' && block.state === 'running' && block.output?.includes('cancellation probe started')) ?? false; if (ready) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert(ready, 'Native shell is running before deletion'); job = core.getSnapshot().active!;
    await core.purge(job); await running;
    assert(!await core.harness.conversation(job, BACKGROUND_CONTEXT), 'Deletion joins native shell and removes its conversation'); job = null;
    const file = await Rxd.importSource(`deletion-${token}.js`, 'export function deletionDeviceProbe(value) { return value + 32; }');
    await core.attach(file); await core.send(`DeleteNative-${token}`, file.id);
    const victim = core.getSnapshot().active!;
    assert(core.getSnapshot().turns.at(-1)?.tools.some((tool) => tool.text.includes('deletionDeviceProbe')), 'Real Android rxd result is stored before deletion');
    const saved = await core.saveArtifact(core.getSnapshot().artifacts.find((artifact) => artifact.kind === 'report')!.id);
    const library = core.fileLibrary;
    await core.purge(victim);
    assert(!await core.harness.conversation(victim, BACKGROUND_CONTEXT) && !(await core.search(`DeleteNative-${token}`)).length, 'Deleted history is absent from storage API and search');
    let rejected = false; try { await core.select(victim); } catch { rejected = true; }
    assert(rejected, 'Direct selection of deleted history fails');
    for (const retained of [file, saved]) {
      const record = await library.get(retained.id); const preview = await Rxd.readCapture(retained.uri, retained.sha256);
      assert(record?.status === 'active' && preview.sha256 === retained.sha256 && preview.size === retained.size, `Independent file metadata and bytes retained: ${retained.name}`);
    }
    assert(!(await library.usage(file.id)).length, 'Last conversation link is removed without deleting the file');
    if (before.active !== null) { await core.select(before.active); assert(core.getSnapshot().turns.map((turn) => turn.id).join(',') === before.turns.map((turn) => turn.id).join(','), 'Unrelated original conversation survives'); }
    await core.select(null); await core.attachExisting(file.id); await core.send(`DeleteUI-${token}`, file.id);
    const id = core.getSnapshot().active!, title = core.getSnapshot().title; await core.archive(id, true);
    Rxd.report(JSON.stringify({ event: 'arxd-deletion', verified: true, checks, fixture: { id, title, fileName: file.name, savedName: saved.name } }));
  } finally {
    if (job && await core.harness.conversation(job, BACKGROUND_CONTEXT)) { await core.select(job); await core.stop(); }
    await running?.catch(() => undefined); await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active);
  }
}
