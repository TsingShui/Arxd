import { requireVerification } from './access';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type ConversationId } from '@earendil-works/pi-durable';
import Rxd, { type WorkspaceFile } from '../../modules/rxd';
import type { Owner } from './services';
import type { ServiceProbeStep } from './services-provider';
import type { TurnView } from '../workspace/core';
import { publishEvidence } from './evidence';
const Preferences = defineDoc<{ active: ConversationId | null; conversations: ConversationId[] }>({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ active: null, conversations: [] }) });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const immediate = (value: unknown) => !!value && typeof (value as { then?: unknown }).then !== 'function';
async function shell(script: string) { const value = await Rxd.runTermux(script, 15000); if (value.exitCode !== 0) throw new Error('Deletion fixture shell failed: ' + value.stderr.slice(0, 400)); return value.stdout.trim(); }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string) { for (let i = 0; i < 100; i++) { const value = await read(); if (ready(value)) return value; await delay(100); } throw new Error('Timed out: ' + label); }
async function references(owner: Owner, ids: ConversationId[]) {
  const prefs = await owner.core.harness.snapshot(Preferences, BACKGROUND_CONTEXT);
  if (!prefs || ids.some((id) => prefs.active === id || prefs.conversations.includes(id))) throw new Error('Materialized durable preferences retain an erased conversation reference');
  for (const id of ids) {
    if (await owner.core.harness.conversation(id, BACKGROUND_CONTEXT)) throw new Error('Purged conversation still exists');
    const docs = await owner.database.get<{ count: number }>("SELECT count(*) AS count FROM documents WHERE scope_kind='conversation' AND owner_id=?", id);
    if (docs?.count !== 0) throw new Error('Purged owner retains capacity/timing/request documents');
  }
}
/** Actual native services, Keystore, shell skills and SQLite across real purges. */
export async function verifyServiceDeletion(owner: Owner, options: {
  original: ConversationId; stdioServer: string; stdioProcess: string; httpServer: string; httpProcess: string; echoProcess: string; file: WorkspaceFile;
  plan(steps: ServiceProbeStep[]): Promise<TurnView['tools']>; assert(value: unknown, label: string): void;
}) {
  const { core, host, state } = owner, { assert } = options;
  const services = core.services!, mcp = services.mcp, skills = core.skills;
  const retainedList = mcp.list, retainedCredentials = mcp.credentials, retainedScan = skills.scanStatus, capabilities = services.processes.capabilities;
  const scope = mcp.scope, survivor = core.getSnapshot().active!;
  assert(immediate(retainedScan()) && immediate(capabilities()) && typeof scope === 'string', 'Scan status/capabilities are synchronous values and MCP scope is a string');
  let skillEvents = 0, mcpEvents = 0;
  const offSkills = skills.subscribe(() => skillEvents++), offMcp = mcp.subscribe(() => mcpEvents++);
  assert(typeof offSkills === 'function' && typeof offMcp === 'function', 'Manager subscriptions return synchronous unsubscribe functions');
  const name = 'facade-' + globalThis.crypto.randomUUID().slice(0, 8);
  const definition = `---\nname: ${name}\ndescription: Native lifecycle facade verification.\n---\nTrusted fixture only.\n`;
  let installed = false, skillId: string | undefined, releaseCredential: (() => void) | undefined;
  const before = await Promise.all([host.inspect(options.echoProcess), host.inspect(options.stdioProcess), host.inspect(options.httpProcess)]);
  const preserved = async () => {
    const after = await Promise.all(before.map((record) => host.inspect(record.id)));
    assert(after.every((record, index) => record.state === 'running' && record.pid === before[index].pid && record.payloadPid === before[index].payloadPid && record.startedAt === before[index].startedAt), 'Real purge preserves echo/stdio/HTTP instance PID and start identity');
    assert(await shell(`cat ${quote(state.directory + '/launches')}`) === '1' && await shell(`cat ${quote(state.directory + '/stdio/launches')}`) === '1' && await shell(`cat ${quote(state.directory + '/stdio/initializations')}`) === '1' && await shell(`cat ${quote(state.directory + '/http-mcp/launches')}`) === '1', 'Real purge never relaunches a payload or reinitializes stdio MCP');
    const rows = await retainedList();
    assert(rows.some((row) => row.id === options.stdioServer && row.enabled) && rows.some((row) => row.id === options.httpServer && row.enabled && row.hasCredential), 'Cached MCP manager retains enabled definitions and credential metadata');
    assert(!!await host.credentials.get(options.httpServer), 'Native encrypted credential remains present across deletion');
    assert(mcp.scope === scope && owner.controls.watches === 1 && owner.controls.watchStarts - owner.controls.watchStops === 1, 'Workspace scope is stable and exactly one native skills watcher remains');
  };
  try {
    await shell(`test ! -e "$ARXD_SKILLS/${name}" && mkdir "$ARXD_SKILLS/${name}" && printf %s ${quote(definition)} > "$ARXD_SKILLS/${name}/SKILL.md"`); installed = true;
    const rows = await until(() => skills.list(), (rows) => rows.some((row) => row.name === name && row.enabled && row.status === 'active'), 'automatic native shell skill discovery');
    skillId = rows.find((row) => row.name === name)!.id;
    // Hold a completed native Keystore write before the real SQLite save.
    let entered!: () => void;
    const atCredential = new Promise<void>((resolve) => { entered = resolve; });
    const credentialGate = new Promise<void>((resolve) => { releaseCredential = resolve; });
    owner.controls.credential = async () => { owner.controls.credential = undefined; entered(); await credentialGate; };
    const credential = retainedCredentials(options.httpServer, { Authorization: 'Bearer fixture-token', 'X-Arxd-Fixture': 'fixture-header' });
    void credential.catch(() => undefined);
    await Promise.race([atCredential, credential.then(() => { throw new Error('Credential control bypassed its held persistence boundary'); }), delay(5000).then(() => { throw new Error('Native credential did not enter its persistence gate'); })]);
    await core.select(options.original);
    let finished = false;
    const purging = core.purge(options.original).then((snapshot) => { finished = true; return snapshot; }); void purging.catch(() => undefined);
    await delay(250); assert(!finished, 'Purge joins an accepted async MCP control before closing its database lease');
    let rejected = false; try { await mcp.enabled(options.stdioServer, false); } catch { rejected = true; }
    assert(rejected, 'New manager mutations cannot race session replacement');
    releaseCredential!(); await credential; await purging;
    assert(core.getSnapshot().active === null, 'Deleting the active conversation clears durable active selection');
    await references(owner, [options.original]); await preserved();
    assert((await core.fileLibrary.get(options.file.id))?.status === 'active' && (await Rxd.readCapture(options.file.uri, options.file.sha256)).sha256 === options.file.sha256, 'True deletion retains independent source bytes and metadata');
    await core.select(survivor);
    await options.plan([{ name: 'mcp_tools', args: { id: options.stdioServer } }, { name: { ref: '0.tools.0.alias' }, args: { text: 'STDIO_AFTER_TRUE_PURGE' } }]);
    let httpTools = await options.plan([{ name: 'mcp_tools', args: { id: options.httpServer } }, { name: { ref: '0.tools.0.alias' }, args: { text: 'PI_HTTP_ACTUAL_RESULT' } }]);
    assert(httpTools.at(-1)?.text.includes('PI_HTTP_ACTUAL_RESULT') && await shell(`cat ${quote(state.directory + '/http-mcp/initializations')}`) === '1', 'Another conversation calls credentialed HTTP MCP with one initialization after purge');
    await core.select(null); await core.send('Second ownerless deletion fixture.'); const second = core.getSnapshot().active!;
    await core.purge(second); assert(core.getSnapshot().active === null, 'A second active purge clears its selection');
    await references(owner, [options.original, second]); await preserved();
    await core.select(survivor);
    httpTools = await options.plan([{ name: 'mcp_tools', args: { id: options.httpServer } }, { name: { ref: '0.tools.0.alias' }, args: { text: 'PI_HTTP_ACTUAL_RESULT' } }]);
    await options.plan([{ name: 'mcp_tools', args: { id: options.stdioServer } }, { name: { ref: '0.tools.0.alias' }, args: { text: 'STDIO_AFTER_SECOND_PURGE' } }]);
    assert(await shell(`cat ${quote(state.directory + '/http-mcp/initializations')}`) === '1', 'Repeated session replacement reuses HTTP MCP initialization');
    await delay(1400); // Consume the replacement watcher's initial authoritative hint.
    const skillsBefore = skillEvents, mcpBefore = mcpEvents;
    await skills.enabled(skillId, false); await mcp.enabled(options.stdioServer, true);
    assert(skillEvents - skillsBefore === 1 && mcpEvents - mcpBefore === 1, 'Retained subscriptions rebind once across two purges without duplicate callbacks');
    offSkills(); offMcp(); const stoppedSkills = skillEvents, stoppedMcp = mcpEvents;
    await skills.enabled(skillId, true); await mcp.enabled(options.stdioServer, true);
    assert(skillEvents === stoppedSkills && mcpEvents === stoppedMcp, 'Synchronous unsubscribe detaches replacement-manager callbacks');
    assert(immediate(retainedScan()) && immediate(capabilities()), 'Held synchronous methods remain immediate after repeated purge');
    state.deletion = { purged: [options.original, second], survivor, file: { id: options.file.id, uri: options.file.uri, sha256: options.file.sha256 } };
    assert(!await core.harness.conversation(options.original, BACKGROUND_CONTEXT), 'Original conversation is erased rather than merely forgotten');
    return httpTools;
  } finally {
    releaseCredential?.(); owner.controls.credential = undefined; offSkills(); offMcp();
    if (skillId) await skills.remove(skillId).catch(() => undefined);
    else if (installed) { await shell(`rm -rf "$ARXD_SKILLS/${name}"`).catch(() => undefined); await skills.refresh().catch(() => undefined); }
  }
}
export async function reopenServiceDeletion(owner: Owner) {
  requireVerification();
  const state = owner.state.deletion;
  if (!state || state.purged.length !== 2 || state.purged.some((id) => !Number.isSafeInteger(id) || id <= 1) || !state.capacity || !state.turns) throw new Error('Missing completed purge/reopen fixture');
  await references(owner, state.purged as ConversationId[]); await owner.core.select(state.survivor as ConversationId);
  if (!owner.state.serviceDefinitionId || (await owner.host.definition(owner.state.serviceDefinitionId)).id !== owner.state.serviceDefinitionId || !(await owner.host.definitions()).total) throw new Error('Cold reopen lost the saved service definition after instance cleanup');

  const capacity = await until(async () => (await owner.core.refresh()).capacity, (value) => value.state === 'current', 'cold-reopen survivor capacity');
  if (capacity.tokens !== state.capacity.tokens || capacity.limit !== state.capacity.limit || capacity.revision !== state.capacity.revision || JSON.stringify(owner.core.getSnapshot().turns.map((turn) => turn.id)) !== JSON.stringify(state.turns) || owner.traces.length) throw new Error('Cold reopen changed survivor context/capacity or replayed a request');
  if ((await owner.core.fileLibrary.get(state.file.id))?.status !== 'active' || (await Rxd.readCapture(state.file.uri, state.file.sha256)).sha256 !== state.file.sha256) throw new Error('Cold reopen lost independent captured file');
  const stdioLaunches = await shell(`cat ${quote(owner.state.directory + '/stdio/launches')}`);
  const httpLaunches = await shell(`cat ${quote(owner.state.directory + '/http-mcp/launches')}`);
  if (stdioLaunches !== '1' || httpLaunches !== '1') throw new Error('Cold reopen changed native launch counts: ' + JSON.stringify({ stdioLaunches, httpLaunches }));
  const launchesBefore = Number(await shell(`cat ${quote(owner.state.directory + '/launches')}`));
  const explicit = await owner.host.start(`definition-reopen-${owner.state.run}`, { definitionId: owner.state.serviceDefinitionId });
  try {
    const running = await until(() => owner.host.inspect(explicit.id), (record) => record.state === 'running', 'explicit definition start after cold reopen');
    await until(() => shell(`cat ${quote(owner.state.directory + '/launches')}`), (value) => Number(value) === launchesBefore + 1, 'one post-reopen explicit launch effect');
    if (running.definitionId !== owner.state.serviceDefinitionId) throw new Error('Explicit cold-reopen start lost the definition or duplicated its launch');
  } finally {
    const stopped = await owner.host.stop(explicit.id);
    if (stopped.state !== 'exited' || stopped.processMaySurvive) throw new Error('Explicit definition reopen cleanup is unverified');
    await owner.host.remove(explicit.id);
  }

  publishEvidence(JSON.stringify({ event: 'arxd-services-functional-reopen', verified: true, run: owner.state.run, purged: state.purged, survivor: state.survivor, capacity, modelRequests: owner.traces.length, credentialValuesIncluded: false }));
}
