import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import { requireVerification } from './access';
import { setCapacitySummary, setCapacityGeneration } from './capacity-provider';
import { publishEvidence } from './evidence';

let fixture: { connection: string; skill: string; file: string; name: string; motion: 'system' | 'reduced'; palette: 'fire' | 'spring' } | undefined;
let sequence = 0;
let summaries = 0;
let releaseSummary: (() => void) | undefined;
let releaseGeneration: (() => void) | undefined;
let generationTask: Promise<unknown> | undefined;

/** The driver compares this actual committed state across native details/theme operations. */
export async function inspectCapacityUi(core: Workspace, phase: string) {
  requireVerification();
  for (let i = 0; i < 80 && (await core.refresh()).capacity.state !== 'current'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const snapshot = core.getSnapshot();
  const conversation = snapshot.active && await core.harness.conversation(snapshot.active, BACKGROUND_CONTEXT);
  const context = conversation && await conversation.context(BACKGROUND_CONTEXT);
  const raw = conversation && await conversation.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT);
  if (raw?.next !== undefined) throw new Error('Capacity UI fixture raw history exceeds 128 entries');
  publishEvidence(JSON.stringify({ event: 'arxd-context-capacity-ui', phase, sequence: ++sequence, fixture, summaries,
    active: snapshot.active, capacity: snapshot.capacity, entries: context && context.entries.length, head: context && context.head?.id,
    rawEntries: raw?.items.length ?? 0, rawEntryIds: raw?.items.map((entry) => entry.id) ?? [],
    turns: snapshot.turns.length, tools: snapshot.turns.reduce((count, turn) => count + turn.tools.length, 0),
    requests: snapshot.requestRecords?.length ?? 0, selectedSkills: snapshot.selectedSkills.map((skill) => skill.id), busy: snapshot.busy,
    compactions: snapshot.compactions.length, compactionError: snapshot.compactionError, modelLabel: snapshot.modelLabel }));
}

export async function prepareCapacityUi(core: Workspace) {
  requireVerification();
  if (fixture) throw new Error('Capacity UI fixture must be cleaned before another preparation');
  const original = core.getSnapshot();
  const nonce = globalThis.crypto.randomUUID().slice(0, 8);
  const source = 'capacity-ui-' + nonce;
  const name = 'capacity-ui-' + nonce;
  const connection = await core.connections.save({ name: 'Capacity UI inspection', preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:1/never-request-capacity-ui', auth: 'none' });
  await Rxd.createDirectory('workspace', source);
  await Rxd.writeFile('workspace', source + '/SKILL.md', `---\nname: ${name}\ndescription: Native capacity composer selection fixture.\n---\nOffline UI fixture, never executes instructions.\n`, '');
  const skill = await core.skills.import('workspace', source); await core.skills.enabled(skill.id, true);
  const file = await Rxd.importSource('capacity-pending-' + nonce + '.js', 'export const pendingCapacityFixture = 42;\n');
  fixture = { connection: connection.id, skill: skill.id, file: file.id, name, motion: original.motion, palette: original.palette };
  const model = await core.connections.manual(connection.id, { id: 'capacity-ui-long-label', name: 'Capacity reference model with a deliberately long connection-qualified model name and complete 128000 token context window', contextWindow: 128000, maxTokens: 1024, thinking: ['off'] }, {}, true);
  await core.select(null); await core.model('test'); await core.send('<arxd-capacity-probe tokens="32000"/>');
  await core.attach(file); await core.skills.choose(skill.id, true); await core.model(model.id);
  await inspectCapacityUi(core, 'prepared');
}

export async function prepareCapacityManualUi(core: Workspace, mode: 'hold' | 'error' | 'normal') {
  requireVerification();
  releaseSummary?.(); releaseSummary = undefined;
  await core.select(null); await core.model('test'); await core.send('<arxd-capacity-probe tokens="0"/>');
  const conversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  await conversation.commit(async (tx) => { for (let i = 0; i < 3; i++) await tx.appendEntry(conversation.id, { kind: 'arxd.capacity-ui-history', model: [{ role: 'user', content: 'history '.repeat(14000), timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  summaries = 0;
  if (mode === 'error') setCapacitySummary('error');
  else if (mode === 'normal') setCapacitySummary('normal');
  else {
    const gate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    setCapacitySummary(async () => { summaries++; publishEvidence(JSON.stringify({ event: 'arxd-context-capacity-ui-summary', summaries })); await gate; });
  }
  await inspectCapacityUi(core, 'manual-' + mode);
}

export async function releaseCapacityUiSummary(core: Workspace) {
  requireVerification(); releaseSummary?.(); releaseSummary = undefined; setCapacitySummary('normal'); await inspectCapacityUi(core, 'released');
}

export async function prepareCapacityBusyUi(core: Workspace) {
  requireVerification();
  await core.select(null); await core.model('test'); await core.send('<arxd-capacity-probe tokens="0"/>');
  let entered!: () => void;
  const atRequest = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  setCapacityGeneration(async () => { entered(); await gate; });
  generationTask = core.send('<arxd-capacity-probe tokens="0"/>');
  // Attach rejection observation immediately while the real UI owns the task.
  void generationTask.catch(() => undefined);
  await atRequest; await inspectCapacityUi(core, 'generation-held');
}

export async function releaseCapacityBusyUi(core: Workspace) {
  requireVerification(); releaseGeneration?.(); releaseGeneration = undefined;
  try { await generationTask; } finally { generationTask = undefined; setCapacityGeneration(); }
  await inspectCapacityUi(core, 'generation-released');
}

export async function cleanupCapacityUi(core: Workspace) {
  requireVerification();
  await releaseCapacityBusyUi(core);
  await core.cancelCompaction(); releaseSummary?.(); releaseSummary = undefined; setCapacitySummary('normal');
  if (fixture) {
    const previous = fixture;
    await core.skills.choose(previous.skill, false); await core.skills.enabled(previous.skill, false); await core.skills.remove(previous.skill);
    await core.select(null); await core.model('test'); await core.connections.remove(previous.connection); await core.fileLibrary.remove(previous.file);
    await core.motion(previous.motion); await core.palette(previous.palette);
    fixture = undefined;
  }
  await inspectCapacityUi(core, 'cleaned');
}
