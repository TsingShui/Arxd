import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';

export async function verifyArchive(core: Workspace) {
  requireVerification();
  const before = core.getSnapshot(); const checks: string[] = [];
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const token = globalThis.crypto.randomUUID().slice(0, 8);
  let running: ReturnType<Workspace['send']> | undefined;
  let job: typeof before.active = null;
  await core.select(null); await core.model('test');
  try {
    running = core.send('运行 Shell 停止验证'); void running.catch(() => undefined);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { ready = (await core.refresh()).turns.at(-1)?.activities.some((block) => block.kind === 'tool' && block.state === 'running' && block.output?.includes('cancellation probe started')) ?? false; if (ready) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert(ready, 'Real native shell work is running');
    job = core.getSnapshot().active!;
    await core.archive(job, true);
    assert(core.getSnapshot().busy && !!core.getSnapshot().conversations.find((row) => row.id === job)?.archived, 'Archiving retains the running shell');
    await core.select(null); await core.select(job); await core.stop(); await running;
    assert(core.getSnapshot().turns.at(-1)?.status === 'stopped', 'Archived shell can be opened and stopped');
    await core.forget(job); await core.select(null);
    const file = await Rxd.importSource(`archive-${token}.js`, 'export function archiveDeviceProbe(value) { return value + 31; }');
    await core.attach(file); await core.send(`ArchiveUI-${token}`, file.id);
    const id = core.getSnapshot().active!; const title = core.getSnapshot().title;
    assert(core.getSnapshot().turns.at(-1)?.tools.some((tool) => tool.text.includes('archiveDeviceProbe')), 'Real rxd result is stored');
    const artifact = core.getSnapshot().artifacts.find((artifact) => artifact.kind === 'report')!;
    const saved = await core.saveArtifact(artifact.id);
    await core.archive(id, true);
    assert(!(await core.search(title, null, 'active')).length && (await core.search(title, null, 'archived')).some((group) => group.id === id), 'Archive search scope is separate from active search');
    await core.select(null); await core.select(id);
    assert(core.getSnapshot().conversations.find((row) => row.id === id)?.archived, 'Opening archived history does not restore it');
    assert((await core.fileLibrary.get(file.id))?.status === 'active' && (await core.fileLibrary.get(saved.id))?.status === 'active', 'Archive retains captures and saved files');
    Rxd.report(JSON.stringify({ event: 'arxd-archive', verified: true, checks, fixture: { id, title, fileName: file.name, savedName: saved.name } }));
  } finally { if (running) { if (job) await core.select(job); await core.stop(); await running.catch(() => undefined); } await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active); }
}
