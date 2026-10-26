import { requireVerification } from './access';
import '../runtime';
import type { ConversationId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openDatabaseAsync } from 'expo-sqlite';
import Rxd, { type EngineInfo } from '../../modules/rxd';
import { ArxdSqlite } from '../agent/sqlite';
import { openWorkspace, type Workspace } from '../workspace/core';
import { NativeServices, androidServices } from '../workspace/native-services';
import type { ProcessDefinition, ServiceHost } from '../workspace/service-types';
import { serviceProbePrompt, servicesProbeProvider, type ServiceProbeObservation, type ServiceProbeStep } from './services-provider';
import { watchSharedSkills } from '../workspace/shared-skills-watch';
import { verifyServiceDeletion, reopenServiceDeletion } from './services-deletion';
import { publishEvidence } from './evidence';

export type ServicesCase = 'external-http' | 'functional' | 'background' | 'intent' | 'spawn' | 'result' | 'input' | 'mcp' | 'storage';
export type ServiceDeletionState = { purged: ConversationId[]; survivor: ConversationId; file: { id: string; uri: string; sha256: string }; capacity?: { tokens: number | null; limit: number | null; revision: string | null }; turns?: string[] };
type State = { httpPolicyBefore?: boolean; policyLastPid?: number; serviceDefinitionId?: string; deletion?: ServiceDeletionState; version: 1; run: string; profile: ServicesCase; directory: string; startedPid: number; processIds: string[]; serverIds: string[]; processId?: string; serverId?: string; port?: number; externalUrl?: string; checkpoint?: string };
const owners = new Map<string, Promise<Owner>>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const decode = (text: string) => Uint8Array.from(globalThis.atob(text), (character) => character.charCodeAt(0));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt++) { const value = await read(); if (ready(value)) return value; await delay(100); }
  throw new Error('Timed out: ' + label);
}
async function shell(script: string) { const value = await Rxd.runTermux(script, 15000); if (value.exitCode !== 0) throw new Error('Trusted fixture shell failed: ' + value.stderr.slice(0, 500)); return value.stdout.trim(); }
async function save(state: State) {
  const path = `.services-verification-${state.run}-${state.profile}.json`;
  const previous = await Rxd.readFile('workspace', path).catch(() => undefined);
  await Rxd.writeFile('workspace', path, JSON.stringify(state), previous?.sha256 ?? '');
}
const evidence = (value: Record<string, unknown>) => publishEvidence(JSON.stringify(value));
async function checkpoint(state: State, phase: string) {
  state.checkpoint = phase; await save(state);
  evidence({ event: 'arxd-services-checkpoint', run: state.run, profile: state.profile, phase, fixture: state, mode: 'offline-deterministic/real-pi-native-effects' });
  await new Promise<void>(() => undefined);
}
export type Owner = { core: Workspace; info: EngineInfo; state: State; traces: ServiceProbeObservation[]; processFixture: string; mcpFixture: string; host: ServiceHost; database: ArxdSqlite; controls: { modelGate?: (step: number) => Promise<void>; credential?: () => Promise<void>; watches: number; watchStarts: number; watchStops: number } };
export function openServicesVerification(run: string, profile: ServicesCase, resume: boolean, externalUrl?: string) {
  requireVerification();
  const key = `${run}-${profile}`;
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(run)) throw new Error('Invalid verification run');
  let opening = owners.get(key);
  if (opening) return opening;
  opening = (async () => {
    const info = await Rxd.getInfo();
    if (!/^[a-f0-9]{64}$/.test(info.engineSha256) || !info.sourceRevision || info.debuggable !== false || !info.processId) throw new Error('Acceptance requires identified real rxd and a non-debuggable Android process');
    await Rxd.prepareTermux();
    const relative = `arxd-services-${run}-${profile}`;
    let state: State;
    if (resume) {
      state = JSON.parse((await Rxd.readFile('workspace', `.services-verification-${run}-${profile}.json`)).text!) as State;
      const expected = await shell(`printf '%s' "$ARXD_WORKSPACE/${relative}"`);
      if (state.version !== 1 || state.run !== run || state.profile !== profile || state.directory !== expected || state.processIds.length > 32 || state.serverIds.length > 32 || [...state.processIds, ...state.serverIds].some((id) => !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Unsupported or invalid services verification state');
    }
    else {
      await Rxd.createDirectory('workspace', relative);
      const directory = await shell(`printf '%s' "$ARXD_WORKSPACE/${relative}"`);
      state = { version: 1, run, profile, directory, startedPid: info.processId, processIds: [], serverIds: [], externalUrl }; await save(state);
    }
    const processFixture = await NativeServices.fixture('process-fixture.py'), mcpFixture = await NativeServices.fixture('mcp-fixture.py');
    const traces: ServiceProbeObservation[] = [];
    const controls: Owner['controls'] = { watches: 0, watchStarts: 0, watchStops: 0 };
    const host: ServiceHost = { ...androidServices,
      credentials: { ...androidServices.credentials, set: async (id, value) => { await androidServices.credentials.set(id, value); await controls.credential?.(); } },
      start: async (admission, definition) => {
        if (!resume && profile === 'intent') await checkpoint(state, 'durable-tool-intent-before-native-start');
        const value = await androidServices.start(admission, definition);
        if (!state.processIds.includes(value.id)) state.processIds.push(value.id);
        state.processId = value.id; await save(state);
        if (!resume && profile === 'spawn') {
          await until(() => androidServices.inspect(value.id), (record) => record.state === 'running', 'verified spawn');
          await until(() => shell(`test ! -f ${quote(state.directory + '/launches')} || cat ${quote(state.directory + '/launches')}`), (value) => value === '1', 'fsynced spawn effect');
          await checkpoint(state, 'native-spawn-effect-before-tool-result');
        }
        return value;
      },
      write: async (id, text, close) => {
        await androidServices.write(id, text, close);
        if (!resume && profile === 'input') {
          await until(() => shell(`test ! -f ${quote(state.directory + '/inputs')} || cat ${quote(state.directory + '/inputs')}`), (value) => value === '1', 'fsynced stdin effect');
          await checkpoint(state, 'stdin-effect-before-tool-result');
        }
      },
      mcpRequestBound: async (server, connectionId, toolsRevision, invocation, method, params, timeout, catalogId) => {
        const value = await androidServices.mcpRequestBound(server, connectionId, toolsRevision, invocation, method, params, timeout, catalogId);
        if (!resume && profile === 'mcp' && method === 'tools/call' && (params as { name?: string }).name === 'increment') await checkpoint(state, 'mcp-effect-before-tool-result');
        return value;
      },
    };
    const db = await openDatabaseAsync(`arxd-services-${key}.sqlite`);
    await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const database = new ArxdSqlite(db);
    const core = await openWorkspace(database, { info, services: host,
      offlineResponse: servicesProbeProvider((value) => { traces.push(value); if (traces.length > 256) traces.shift(); }, async (step, signal) => {
        if (!resume && profile === 'result' && step === 1) {
          await until(() => androidServices.inspect(state.processId!), (record) => record.state === 'running', 'result-boundary process');
          await until(() => shell(`test ! -f ${quote(state.directory + '/launches')} || cat ${quote(state.directory + '/launches')}`), (value) => value === '1', 'fsynced completed-start effect');
          await checkpoint(state, 'committed-tool-result-before-next-provider-response');
        }
        await controls.modelGate?.(step);
        if (signal?.aborted) throw new Error('Offline provider canceled');
      }),
      diagnostic: (error) => evidence({ event: 'arxd-services-diagnostic', run, profile, error: String(error).slice(0, 1000) }),
probe: async (script: string, timeoutMs: number) => {
        const result = await Rxd.runTermux(script, timeoutMs);
        if (result.exitCode !== 0) throw new Error(result.stderr || `rxd probe exit ${result.exitCode}`);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
      skills: {
        discover: () => Rxd.discoverSkills(), rename: (id, name) => Rxd.renameSkill(id, name), collect: (keep) => Rxd.collectSkillVersions(keep),
        watch: (changed) => { controls.watches++; controls.watchStarts++; const off = watchSharedSkills(changed); let active = true; return () => { if (!active) return; active = false; controls.watches--; controls.watchStops++; off(); }; },
        importFile: (id, uri) => Rxd.importSkillFile(id, uri), importArchive: (id, uri) => Rxd.importSkillArchive(id, uri), importWorkspace: (id, path) => Rxd.importSkillWorkspace(id, path),
        working: (id) => Rxd.readSkillWorking(id), write: (id, text, expected) => Rxd.writeSkillDefinition(id, text, expected), snapshot: (id, name, prune) => Rxd.snapshotSkill(id, name, prune),
        read: (id, name, version, path, expected, offset, limit) => Rxd.readSkillResource(id, name, version, path, expected, offset, limit), remove: (id) => Rxd.removeSkill(id),
      },
      files: { save: (name, text) => Rxd.saveArtifact(name, text), capture: (root, path) => Rxd.captureFile(root, path), remove: (file) => Rxd.deleteCapture(file.uri, file.sha256) },
      shell: { run: (id, script, timeout) => { const key = `services-${run}-${id}`; Rxd.registerShell(key); return Rxd.runShell(key, script, timeout); }, cancel: (id) => Rxd.cancelShell(`services-${run}-${id}`), progress: (id) => Rxd.shellProgress(`services-${run}-${id}`) },
    });
    return { core, info, state, traces, processFixture, mcpFixture, host, database, controls };
  })();
  owners.set(key, opening); return opening;
}
function definition(owner: Owner, mode: string, directory = owner.state.directory): ProcessDefinition {
  return { name: `Verification ${owner.state.run} ${mode}`, argv: ['python', owner.processFixture, mode, directory], identity: 'app', cwd: owner.state.directory, environment: { ARXD_FIXTURE_VALUE: 'shared-workspace-✓' } };
}
async function plan(owner: Owner, steps: ServiceProbeStep[]) {
  await owner.core.send(serviceProbePrompt(steps));
  const turn = owner.core.getSnapshot().turns.at(-1)!;
  if (turn.tools.length !== steps.length || turn.tools.some((tool, i) => tool.isError && !steps[i].allowError)) throw new Error('Actual Pi tool plan failed: ' + turn.tools.map((tool) => `${tool.name}:${tool.isError}:${tool.text.slice(0, 500)}`).join(' | '));
  return turn.tools;
}
async function stop(owner: Owner, id: string) { const value = await owner.host.stop(id); if (value.state !== 'exited' || value.processMaySurvive) throw new Error('Owned stop was not verified: ' + JSON.stringify(value)); return value; }
async function cleanup(owner: Owner) {
  const failures: string[] = [];
  for (const server of owner.state.serverIds) { try { await owner.core.services!.mcp.remove(server); } catch (error) { failures.push(`mcp:${server}: ${String(error).slice(0, 200)}`); } }
  for (const id of owner.state.processIds) { try { const record = await owner.host.inspect(id); if (!['exited', 'failed'].includes(record.state) || record.processMaySurvive) await stop(owner, id); await owner.host.remove(id); } catch (error) { failures.push(`${id}: ${String(error).slice(0, 200)}`); } }
  return failures;
}

/** Trusted, explicitly requested isolated switch acceptance; no Agent setter is installed. */
export async function externalHttpServices(owner: Owner, stage: string, status: (text: string) => void) {
  requireVerification();
  const { core, host, state } = owner, checks: string[] = [];
  const mcp = core.services!.mcp;
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const endpoint = new URL(state.externalUrl ?? '');
  const octets = endpoint.hostname.split('.').map(Number);
  if (endpoint.protocol !== 'http:' || octets.length !== 4 || !octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ||
      !(octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168) ||
      !endpoint.port || endpoint.pathname !== '/json' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an explicitly controlled RFC1918 IPv4 HTTP fixture /json URL');
  const rejects = async (run: () => Promise<unknown>, label: string) => { let error = ''; try { await run(); } catch (failure) { error = String(failure); } assert(/Plain HTTP MCP is disabled/.test(error), label); };
  const initial = mcp.httpPolicy();
  if (stage === 'run') state.httpPolicyBefore = initial.allowPlaintextHttp;
  else assert(state.policyLastPid !== owner.info.processId, 'Policy acceptance reopens in a fresh Android host process');
  await core.model('test');
  let complete = false;
  try {
    if (stage === 'run') {
      assert(initial.source !== 'default' || !initial.allowPlaintextHttp, 'A missing native preference defaults OFF');
      await mcp.setHttpPolicy(false);
      const policy = JSON.parse(NativeServices.verifyHttpPolicy(endpoint.hostname)) as { host: string; cleartextPermitted: boolean; globalCleartextPermitted: boolean };
      assert(policy.host === endpoint.hostname && policy.cleartextPermitted && policy.globalCleartextPermitted, 'Android retains the model HTTP baseline while the independent MCP switch is OFF');
      for (const [index, mode] of ['none', 'token', 'header'].entries()) {
        status('Controlled non-loopback Pi/NativeMcp switch acceptance: ' + mode);
        const url = new URL(mode === 'none' ? '/json' : '/auth-' + mode, endpoint).href;
        const config = await mcp.configure({ name: `HTTP switch ${mode} ${state.run}`, transport: 'http', enabled: true, url });
        state.serverIds.push(config.id); await save(state);
        if (mode !== 'none') await mcp.credentials(config.id, mode === 'token' ? { Authorization: 'Bearer fixture-token' } : { 'X-Arxd-Fixture': 'fixture-header' });
        if (index === 0) {
          await rejects(() => mcp.connect(config.id), 'OFF blocks the saved public-library connection');
          await rejects(() => host.mcpConnect({ id: config.id, transport: 'http', url }), 'OFF blocks direct native connection before network dispatch');
          const blocked = (await mcp.list()).find((row) => row.id === config.id)!;
          assert(blocked.policyBlocked && blocked.enabled, 'An existing enabled HTTP configuration is retained and explicitly policy-blocked');
          await mcp.setHttpPolicy(true); // Trusted acceptance simulates the explicit UI decision; never an Agent tool.
        }
        const results = await plan(owner, [{ name: 'mcp_connect', args: { id: config.id } }, { name: 'mcp_tools', args: { id: config.id, query: 'increment' } }, { name: { ref: '1.tools.0.alias' }, args: {} }]);
        assert(JSON.parse(results[2].text).result?.content?.[0]?.text === String(index + 1), 'Real Pi/native non-loopback ' + mode + ' effect executes once after opt-in');
        const tool = (await mcp.tools(config.id, 'increment', 0)).tools[0];
        const binding = (await host.mcpStates()).find((row) => row.id === config.id)!;
        if (index === 2) {
          await mcp.setHttpPolicy(false);
          await rejects(() => host.mcpRequestBound(config.id, binding.connectionId!, binding.toolsRevision!, globalThis.crypto.randomUUID(), 'tools/call', { name: 'increment', arguments: {} }, 10000, tool.catalogId), 'OFF blocks a cached native offered-tool binding');
          const stale = await plan(owner, [{ name: tool.alias, args: {}, allowError: true }]);
          assert(stale[0].isError, 'OFF withdraws cached remote aliases from the actual Pi registry');
          const retained = (await mcp.list()).find((row) => row.id === config.id)!;
          assert(retained.policyBlocked && retained.hasCredential && !retained.processId && !retained.launch, 'OFF retains secure credentials/configuration and claims no external process');
        }
      }
      assert(state.processIds.length === 0, 'External HTTP switch acceptance starts no managed process');
      await mcp.setHttpPolicy(true); // Persist ON, without connecting or replaying any request.
    } else if (stage === 'reopen') {
      assert(initial.allowPlaintextHttp && initial.source === 'saved', 'Explicit ON survives host restart independently from conversations');
      assert((await mcp.list()).filter((row) => state.serverIds.includes(row.id)).length === 3, 'Saved HTTP configurations survive restart without automatic connection');
      await mcp.setHttpPolicy(false);
    } else if (stage === 'finish') {
      assert(!initial.allowPlaintextHttp && initial.source === 'saved', 'Explicit OFF survives another fresh host restart');
      const retained = (await mcp.list()).filter((row) => state.serverIds.includes(row.id));
      assert(retained.length === 3 && retained.every((row) => row.policyBlocked) && retained.filter((row) => row.hasCredential).length === 2, 'OFF migration retains every saved config and credential reference');
      // Exact owned preference in an isolated verification build; exercise corrupt-file recovery at the real reopen seam.
      await shell('printf %s corrupt-policy > "$ARXD_WORKSPACE/../http-mcp-policy.json"');
    } else if (stage === 'resume') {
      assert(!initial.allowPlaintextHttp && initial.source === 'invalid' && !!initial.error, 'Corrupt native preference fails closed after a fresh host restart');
      const first = (await mcp.list()).find((row) => row.id === state.serverIds[0])!;
      await rejects(() => mcp.connect(first.id), 'Corrupt policy blocks retained HTTP configuration before credential/network access');
      await mcp.setHttpPolicy(state.httpPolicyBefore ?? false);
      const cleanupFailures = await cleanup(owner);
      assert(cleanupFailures.length === 0, 'Policy acceptance removes only its test configs and restores the previous switch value');
      complete = true;
    } else throw new Error('Unsupported HTTP policy acceptance stage');
    state.policyLastPid = owner.info.processId; await save(state);
    evidence({ event: 'arxd-services-external-http', verified: true, run: state.run, stage, checks, initialPolicy: initial, policy: mcp.httpPolicy(), endpoint: endpoint.href, processIds: state.processIds, complete, info: owner.info, mode: 'controlled-lan/real-android-policy-pi-native-okhttp' });
  } catch (error) {
    await mcp.setHttpPolicy(state.httpPolicyBefore ?? false).catch(() => undefined);
    const cleanupFailures = await cleanup(owner);
    evidence({ event: 'arxd-services-external-http', verified: false, run: state.run, stage, checks, cleanupFailures, error: String(error) });
    throw error;
  }
}

export async function functionalServices(owner: Owner, status: (text: string) => void) {
  requireVerification();
  const { core, host, state } = owner; const checks: string[] = [];
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const rejects = async (action: () => Promise<unknown>, label: string) => { let failed = false; try { await action(); } catch { failed = true; } assert(failed, label); };
  let verified = false;
  const previousHttp = core.services!.mcp.httpPolicy().allowPlaintextHttp;
  try {
    await core.services!.mcp.setHttpPolicy(true); // Explicit isolated acceptance opt-in.
    status('Pi process_start → independent process tools → real rxd worker');
    await core.model('test');
    const file = await Rxd.importSource('services-while-alive.js', 'export function servicesWhileAlive(value) { return value + 1; }\n');
    await core.attach(file); const original = core.getSnapshot().active!;
    const started = performance.now();
    const first = await plan(owner, [{ name: 'process_start', args: definition(owner, 'echo') }, { name: 'process_inspect', args: { id: { ref: '0.id' } } }]);
    const id = String(JSON.parse(first[0].text).id), firstDuration = performance.now() - started;
    await until(() => host.inspect(id), (record) => record.state === 'running', 'ordinary service running');
    const rxdTurn = await shell(`set -eu\n"$ARXD_RXD" js entities "$ARXD_WORKSPACE/workspace-inputs/"*services-while-alive*.js 2>/dev/null || find "$ARXD_WORKSPACE" -name 'services-while-alive.js' -print -quit`);
    assert(rxdTurn.includes('servicesWhileAlive'), 'rxd CLI analyzes the immutable attachment through the managed shell');
    const runtime = await Rxd.prepareTermux();
    assert((await host.inspect(id)).observedUid === Number(runtime.uid), 'Ordinary service observed identity matches the App UID');
    status('Persistent stdin, separate streams, byte cursors and binary fidelity');
    await until(() => host.logs(id, 'stdout', 0, 4096), (page) => page.text?.includes('prefix-✓') === true, 'split UTF-8 output');
    const observedCwd = await shell(`cat ${quote(state.directory + '/cwd')}`);
    const sameCwd = await shell(`test ${quote(observedCwd)} -ef ${quote(state.directory)} && printf same-directory`);
    assert(sameCwd === 'same-directory' && await shell(`cat ${quote(state.directory + '/environment')}`) === 'shared-workspace-✓', 'Actual argv launch preserves requested directory identity and explicit UTF-8 environment');
    const firstRecord = await host.inspect(id);
    assert(Number(await shell(`cat ${quote(state.directory + '/pgid')}`)) === firstRecord.pid && Number(await shell(`cat ${quote(state.directory + '/pid')}`)) === firstRecord.payloadPid,
      'Actual payload retains the verified supervisor group and its separate payload PID');
    assert(await shell(`cat ${quote(state.directory + '/startup_job')}`) === 'absent', 'Bootstrap job identity is absent from the actual payload environment');
    const same = await host.start(firstRecord.admissionId, { ...definition(owner, 'echo'), origin: firstRecord.origin });
    assert(same.id === id && await shell(`cat ${quote(state.directory + '/launches')}`) === '1', 'Repeated identical native admission returns one instance without another launch');
    const logTool = await plan(owner, [{ name: 'process_logs', args: { id, stream: 'stdout', cursor: 0, maxBytes: 4096 } }]);
    assert(logTool[0].text.includes('prefix-✓'), 'Actual Pi process_logs returns retained Unicode output and cursors');
    const err = await host.logs(id, 'stderr', 0, 4096);
    assert(err.text?.includes('trusted-process-fixture-ready') && !err.text.includes('prefix-✓'), 'stdout and stderr remain separate and split UTF-8 is preserved');
    const writes = await plan(owner, [{ name: 'process_input', args: { id, text: 'first\n' } }, { name: 'process_input', args: { id, text: 'second\n' } }]);
    assert(writes.every((tool) => JSON.parse(tool.text).commandCompletion === false), 'Stdin delivery is distinct from command completion or process exit');
    await until(() => host.logs(id, 'stdout', 0, 4096), (page) => page.text?.includes('input:second') === true, 'persistent shell-style second input');
    const beforeBinary = await host.logs(id, 'stdout', -1, 4096);
    await plan(owner, [{ name: 'process_input', args: { id, text: 'binary\n' } }]);
    const binary = await until(() => host.logs(id, 'stdout', beforeBinary.nextCursor, 4096), (page) => page.nextCursor > beforeBinary.nextCursor, 'binary stdout');
    assert(binary.text === null && Array.from(decode(binary.base64)).join(',') === '0,255,254', 'Binary log pages preserve exact bytes with unavailable text');
    await rejects(() => host.write(id, '界'.repeat(6000)), 'Stdin byte budget rejects oversized UTF-8 before writing');
    const persistent = await host.start(`persistent-shell-${state.run}`, { name: 'Actual persistent Bash', script: 'printf "shell-ready\\n"; exec /system/bin/linker64 "$PREFIX/bin/bash" --noprofile --norc', identity: 'app' });
    await until(() => host.logs(persistent.id, 'stdout', 0, 4096), (page) => page.text?.includes('shell-ready') === true, 'persistent Bash ready');
    await plan(owner, [{ name: 'process_input', args: { id: persistent.id, text: 'ARXD_SESSION_VALUE=kept; cd "$ARXD_WORKSPACE"; printf "first:%s:%s\\n" "$ARXD_SESSION_VALUE" "$PWD"\n' } }, { name: 'process_input', args: { id: persistent.id, text: 'printf "second:%s:%s\\n" "$ARXD_SESSION_VALUE" "$PWD"\n' } }]);
    const shellLog = await until(() => host.logs(persistent.id, 'stdout', 0, 4096), (page) => page.text?.includes('second:kept:') === true, 'same shell state after two writes');
    assert(shellLog.text?.includes('first:kept:') && (await host.inspect(persistent.id)).state === 'running', 'Actual persistent Bash retains variables/cwd across separately delivered commands');
    await stop(owner, persistent.id);
    status('Chat Stop and conversation changes preserve workspace service lifetime');
    const running = core.send(serviceProbePrompt([{ name: 'shell', args: { script: 'printf services-stop-probe; sleep 30', timeoutMs: 60000 } }]));
    await until(async () => { await core.refresh(); return core.getSnapshot().turns.at(-1)?.activities; }, (blocks) => !!blocks?.some((block) => block.kind === 'tool' && block.name === 'shell' && block.state === 'running' && !!block.output), 'real bounded shell progress');
    await core.stop(); await running;
    assert((await host.inspect(id)).state === 'running', 'Chat Stop cancels the bounded request while admitted service continues');
    await core.select(null);
    const listed = await plan(owner, [{ name: 'process_list', args: {} }]);
    assert(JSON.parse(listed[0].text).items.some((entry: { id: string }) => entry.id === id), 'Another real conversation discovers the same workspace-owned instance');
    await core.archive(original, true);
    assert((await host.inspect(id)).state === 'running', 'Conversation archive leaves its workspace service running');

    status('Flood retention, gaps, spawn/exit failures and forced stop');
    const flood = await host.start(`flood-${state.run}`, definition(owner, 'flood', state.directory + '/flood'));
    const page = await until(() => host.logs(flood.id, 'stdout', 0, 49152), (page) => page.totalBytes > Number(host.capabilities().retainedBytesPerStream), 'bounded output flood');
    assert(page.droppedBytes > 0 && page.retainedBytes <= Number(host.capabilities().retainedBytesPerStream) && page.nextCursor > page.cursor, 'Slow readers receive bounded retained logs and explicit gaps');
    await stop(owner, flood.id);
    const exited = await host.start(`exit-${state.run}`, definition(owner, 'exit', state.directory + '/exit'));
    const terminal = await until(() => host.inspect(exited.id), (record) => ['exited', 'failed'].includes(record.state), 'nonzero process exit');
    assert(terminal.exitCode === 37, 'A real nonzero child exit is retained without automatic restart');
    const failed = await host.start(`bad-exec-${state.run}`, { name: 'Missing executable fixture', argv: ['arxd-no-such-executable'], identity: 'app' });
    assert(['exited', 'failed'].includes((await until(() => host.inspect(failed.id), (record) => ['exited', 'failed', 'lost'].includes(record.state), 'spawn failure')).state), 'Missing executable produces an explicit terminal failure');
    const stubborn = await host.start(`stubborn-${state.run}`, definition(owner, 'stubborn', state.directory + '/stubborn'));
    await until(() => host.logs(stubborn.id, 'stdout', 0, 4096), (page) => page.text?.includes('ignoring-term') === true, 'SIGTERM-ignoring fixture');
    await stop(owner, stubborn.id); checks.push('Explicit stop escalates and verifies a SIGTERM-ignoring owned child');
    status('Actual stdio MCP, lazy Pi schema admission and disable/process independence');
    const mcp = core.services!.mcp;
    const configured = await plan(owner, [{ name: 'mcp_configure', args: { name: 'Pi stdio ' + state.run, transport: 'stdio', launch: { name: 'Trusted stdio MCP', argv: ['python', owner.mcpFixture, 'stdio', state.directory + '/stdio'], identity: 'app' } } },
      { name: 'mcp_start', args: { id: { ref: '0.id' } } }, { name: 'mcp_tools', args: { id: { ref: '0.id' } } }, { name: { ref: '2.tools.0.alias' }, args: { text: 'PI_STDIO_ACTUAL_RESULT' } }]);
    const server = String(JSON.parse(configured[0].text).id), linked = String(JSON.parse(configured[1].text).id); state.serverIds.push(server); await save(state);
    assert(configured[3].text.includes('PI_STDIO_ACTUAL_RESULT'), 'Real Pi dynamically calls the native stdio MCP fixture');
    const offeredAlias = String(JSON.parse(configured[2].text).tools[0].alias);
    assert(owner.traces.some((trace) => trace.step === 0 && !trace.offered.includes(offeredAlias)) && owner.traces.some((trace) => trace.step === 3 && trace.offered.includes(offeredAlias)), 'Remote schemas enter the actual model request only after mcp_tools admission');
    assert((await mcp.tools(server, '', 0)).total === 13, 'Workspace MCP library preserves paginated native discovery');
    status('Holding a real Pi model request across a concurrent schema rediscovery');
    let releaseModel: (() => void) | undefined;
    let heldModel!: () => void;
    const held = new Promise<void>((resolve) => { heldModel = resolve; });
    const released = new Promise<void>((resolve) => { releaseModel = resolve; });
    const oldTool = (await mcp.tools(server, 'increment', 0)).tools[0], oldAlias = oldTool.alias;
    owner.controls.modelGate = async (step) => { if (step === 1) { heldModel(); await released; } };
    const pendingOld = plan(owner, [{ name: 'mcp_tools', args: { id: server, query: 'increment' } },
      { name: { ref: '0.tools.0.alias' }, args: {}, allowError: true }]);
    void pendingOld.catch(() => undefined);
    try {
      await Promise.race([held, delay(15000).then(() => { throw new Error('Actual Pi model request did not reach the offered-tool checkpoint'); })]);
      assert(owner.traces.at(-1)?.offered.includes(oldAlias), 'The held real model request was actually offered the captured old alias');
      const beforeRevision = (await host.mcpStates()).find((item) => item.id === server)!;
      await shell(`printf 2 > ${quote(state.directory + '/stdio/schema-version')}`);
      // This is the same public rediscovery entry used by the MCP UI, while
      // another conversation's real provider request is held with old schemas.
      await mcp.discover(server);
      const afterRevision = (await host.mcpStates()).find((item) => item.id === server)!;
      const newAlias = (await mcp.tools(server, 'increment', 0)).tools[0].alias;
      assert(beforeRevision.connectionId === afterRevision.connectionId && beforeRevision.toolsRevision === afterRevision.toolsRevision && oldAlias !== newAlias,
        'Actual discovered schema content changes offered identity even without a native catalog notification');
      await rejects(() => host.mcpRequestBound(server, beforeRevision.connectionId!, beforeRevision.toolsRevision!,
        globalThis.crypto.randomUUID(), 'tools/call', { name: 'increment', arguments: {} }, 10000, oldTool.catalogId),
        'Native atomic admission rejects the old offered catalog even when its connection and notification revision are unchanged');

    } finally { owner.controls.modelGate = undefined; releaseModel?.(); }
    const oldResult = await pendingOld;
    assert(oldResult[1].isError && await shell(`test ! -f ${quote(state.directory + '/stdio/effects')} || cat ${quote(state.directory + '/stdio/effects')}`) === '',
      'A call generated from the held old schema is rejected without one remote side effect');
    const freshResult = await plan(owner, [{ name: 'mcp_tools', args: { id: server, query: 'increment' } }, { name: { ref: '0.tools.0.alias' }, args: {} }]);
    assert(!freshResult[1].isError && await shell(`cat ${quote(state.directory + '/stdio/effects')}`) === '1', 'Explicit new schema admission executes exactly once');

    await rejects(() => host.write(linked, 'raw bytes\n'), 'MCP-owned stdin rejects generic process input');
    assert((await host.logs(linked, 'stdout', 0, 4096)).totalBytes === 0, 'Protocol stdout is not duplicated into ordinary logs');
    await mcp.enabled(server, false);
    assert((await host.inspect(linked)).state === 'running', 'Disabling MCP preserves its process and native pipe ownership');
    await rejects(() => mcp.tools(server, '', 0), 'Disabled MCP cannot admit tools');
    await mcp.enabled(server, true); await mcp.tools(server, '', 0);
    assert(await shell(`cat ${quote(state.directory + '/stdio/launches')}`) === '1' && await shell(`cat ${quote(state.directory + '/stdio/initializations')}`) === '1', 'Reenable reuses one stdio instance without another initialize');
    await core.select(null);
    const fromOther = await plan(owner, [{ name: 'mcp_search', args: { query: 'Pi stdio ' + state.run } }, { name: 'mcp_tools', args: { id: server } }, { name: { ref: '1.tools.0.alias' }, args: { text: 'SECOND_CONVERSATION_MCP' } }]);
    assert(fromOther[2].text.includes('SECOND_CONVERSATION_MCP'), 'Another conversation discovers and lazily calls the same enabled MCP');

    status('Actual HTTP MCP and encrypted-header configuration');
    const http = await host.start(`mcp-http-${state.run}`, { name: 'HTTP MCP fixture', argv: ['python', owner.mcpFixture, 'http', state.directory + '/http-mcp'], identity: 'app' });
    const port = await until(() => shell(`test ! -f ${quote(state.directory + '/http-mcp/port')} || cat ${quote(state.directory + '/http-mcp/port')}`), (text) => /^\d+$/.test(text), 'HTTP MCP port');
    const httpConfig = await mcp.configure({ name: 'Authenticated HTTP fixture', transport: 'http', enabled: true, url: `http://127.0.0.1:${port}/auth`, processId: http.id }); state.serverIds.push(httpConfig.id); await save(state);
    status('Real purge preserves live native services, credentials and retained manager controls');
    const httpTools = await verifyServiceDeletion(owner, { original, stdioServer: server, stdioProcess: linked, httpServer: httpConfig.id, httpProcess: http.id, echoProcess: id, file, plan: (steps) => plan(owner, steps), assert });
    status('Same-name tools, credential replacement and rejected discovery');
    const httpDirectory = state.directory + '/http-mcp';
    const counter = async (directory: string, name: string) => Number(await shell(`test ! -f ${quote(directory + '/' + name)} || cat ${quote(directory + '/' + name)}`));
    const stdioEffects = await counter(state.directory + '/stdio', 'effects'), httpEffects = await counter(httpDirectory, 'effects');
    const isolated = await plan(owner, [{ name: 'mcp_tools', args: { id: server, query: 'increment' } },
      { name: 'mcp_tools', args: { id: httpConfig.id, query: 'increment' } },
      { name: { ref: '0.tools.0.alias' }, args: {} }, { name: { ref: '1.tools.0.alias' }, args: {} }]);
    const stdioAlias = JSON.parse(isolated[0].text).tools[0].alias, httpAlias = JSON.parse(isolated[1].text).tools[0].alias;
    assert(stdioAlias !== httpAlias && JSON.parse(isolated[2].text).serverId === server && JSON.parse(isolated[3].text).serverId === httpConfig.id &&
      await counter(state.directory + '/stdio', 'effects') === stdioEffects + 1 && await counter(httpDirectory, 'effects') === httpEffects + 1,
      'Real Pi isolates same-name tools by distinct aliases, server identities and independent exactly-once counters');
    const oldCredentialError = await plan(owner, [{ name: 'mcp_tools', args: { id: httpConfig.id, query: 'rpc_error' } },
      { name: { ref: '0.tools.0.alias' }, args: {}, allowError: true }]);
    assert(oldCredentialError[1].isError && oldCredentialError[1].text.includes('-32001') && !oldCredentialError[1].text.includes('fixture-token'),
      'Real Pi retains a clear RPC failure while redacting the original HTTP credential');
    const oldCredentialTool = (await mcp.tools(httpConfig.id, 'increment', 0)).tools[0];
    const oldCredentialConnection = (await host.mcpStates()).find((item) => item.id === httpConfig.id)!;
    await shell(`printf %s fixture-replacement-token > ${quote(httpDirectory + '/expected-token')}`);
    await mcp.credentials(httpConfig.id, { Authorization: 'Bearer fixture-replacement-token', 'X-Arxd-Fixture': 'fixture-header' });
    const replacementPosts = await counter(httpDirectory, 'http_posts');
    await rejects(() => host.mcpRequestBound(httpConfig.id, oldCredentialConnection.connectionId!, oldCredentialConnection.toolsRevision!,
      globalThis.crypto.randomUUID(), 'tools/call', { name: 'increment', arguments: {} }, 10000, oldCredentialTool.catalogId),
      'Replacing same-destination credentials rejects a captured old native connection and catalog binding');
    const obsolete = await plan(owner, [{ name: oldCredentialTool.alias, args: {}, allowError: true }]);
    assert(obsolete[0].isError && await counter(httpDirectory, 'http_posts') === replacementPosts && await counter(httpDirectory, 'effects') === httpEffects + 1,
      'Credential replacement withdraws the old actual Pi alias without a POST or mutation');
    const replacement = await plan(owner, [{ name: 'mcp_tools', args: { id: httpConfig.id, query: 'increment' } },
      { name: { ref: '0.tools.0.alias' }, args: {} }]);
    assert(JSON.parse(replacement[0].text).tools[0].alias !== oldCredentialTool.alias && !replacement[1].isError &&
      JSON.parse(replacement[1].text).serverId === httpConfig.id && await counter(httpDirectory, 'effects') === httpEffects + 2,
      'Explicit new Pi admission at the unchanged URL uses the replacement credential and executes once');
    const newCredentialError = await plan(owner, [{ name: 'mcp_tools', args: { id: httpConfig.id, query: 'rpc_error' } },
      { name: { ref: '0.tools.0.alias' }, args: {}, allowError: true }]);
    const publicCredentialState = JSON.stringify(core.getSnapshot().turns) + JSON.stringify(await mcp.list());
    assert(newCredentialError[1].isError && newCredentialError[1].text.includes('-32001') &&
      !publicCredentialState.includes('fixture-token') && !publicCredentialState.includes('fixture-replacement-token') && !publicCredentialState.includes('fixture-header'),
      'Original and replacement credentials stay redacted from actual Pi history and public MCP configuration');
    for (const [path, pattern, posts] of [['invalid-schema', /MCP tool schema must describe an object/, 3], ['duplicate-tools', /schemas are invalid/, 4],
      ['oversized-schema', /schemas are invalid/, 3], ['oversized-catalog', /catalog exceeds 256 tools/, 5]] as const) {
      const invalid = await mcp.configure({ name: 'Rejected discovery ' + path, transport: 'http', enabled: true, url: `http://127.0.0.1:${port}/${path}`, processId: http.id });
      state.serverIds.push(invalid.id); await save(state);
      const before = await counter(httpDirectory, 'http_posts');
      let failure = ''; try { await mcp.discover(invalid.id); } catch (error) { failure = String(error); }
      assert(pattern.test(failure) && (await mcp.list()).find((item) => item.id === invalid.id)?.toolCount === undefined &&
        await counter(httpDirectory, 'http_posts') === before + posts && await counter(httpDirectory, 'effects') === httpEffects + 2,
        `Public discovery rejects ${path} after bounded paginated discovery without publishing tools or executing a mutation`);
    }
    const stoppedTool = await plan(owner, [{ name: 'process_stop', args: { id } }]);
    assert(JSON.parse(stoppedTool[0].text).state === 'exited', 'Actual Pi process_stop returns a verified terminal instance after true deletion');
    assert((await host.stop(id)).id === id, 'Repeated stop is idempotent for the same verified instance');
    const savedDefinition = (await host.inspect(id)).definitionId;
    const launchesBeforeRepeat = Number(await shell(`cat ${quote(state.directory + '/launches')}`));
    const repeated = await plan(owner, [{ name: 'process_start', args: { definitionId: savedDefinition } }]);
    const repeatedId = String(JSON.parse(repeated[0].text).id);
    const repeatedRecord = await until(() => host.inspect(repeatedId), (record) => record.state === 'running', 'explicit saved-definition execution');
    await until(() => shell(`cat ${quote(state.directory + '/launches')}`), (value) => Number(value) === launchesBeforeRepeat + 1, 'one explicit saved-definition launch effect');
    assert(repeatedId !== id && repeatedRecord.definitionId === savedDefinition && (await host.inspect(id)).state === 'exited',
      'Explicit Pi start-by-definition creates a distinct execution and preserves the earlier immutable snapshot');
    assert((await host.definition(savedDefinition)).hasEnvironment && await shell(`cat ${quote(state.directory + '/environment')}`) === 'shared-workspace-✓',
      'Saved reference retains the original private environment without returning it to the model');
    await rejects(() => host.start(`invalid-definition-${state.run}`, { definitionId: savedDefinition, script: 'exit 0' } as never), 'Saved definition reference cannot override the captured launch configuration');
    await rejects(() => host.removeDefinition(savedDefinition), 'Live and retained execution records protect their definition from removal');
    await stop(owner, repeatedId);
    state.serviceDefinitionId = savedDefinition; await save(state);
    const changed = await host.start(`changed-definition-${state.run}`, { ...definition(owner, 'echo'), argv: undefined, script: 'exit 31' });
    const changedRecord = await until(() => host.inspect(changed.id), (record) => record.state === 'exited', 'changed explicit definition exit');
    assert(changedRecord.exitCode === 31 && changed.definitionId !== savedDefinition && (await host.inspect(id)).definitionId === savedDefinition && !!(await host.inspect(id)).argv,
      'Changed launch content gets a new definition while earlier execution snapshots remain unchanged');

    await stop(owner, linked);
    await rejects(() => mcp.connect(server), 'A stopped linked MCP fails without restarting its process');
    assert(httpTools[1].text.includes('PI_HTTP_ACTUAL_RESULT') && !(JSON.stringify(core.getSnapshot().turns) + JSON.stringify(await mcp.list())).includes('fixture-token'), 'Actual Pi HTTP MCP results persist while configured token/header values remain absent from history/catalog');
    await mcp.credentials(httpConfig.id, null); await rejects(() => mcp.connect(httpConfig.id), 'Credential removal makes protected HTTP endpoint fail explicitly');
    status('Requested root is observed or fails truthfully without downgrade');
    const root = await host.start(`root-${state.run}`, { ...definition(owner, 'echo', state.directory + '/root'), identity: 'root' });
    const rootResult = await until(() => host.inspect(root.id), (record) => ['running', 'failed', 'lost', 'exited'].includes(record.state), 'root negotiation', 180);
    const rootVerified = rootResult.state === 'running' && rootResult.observedUid === 0;
    assert(rootVerified || ['failed', 'lost', 'exited'].includes(rootResult.state) && rootResult.observedUid !== Number(runtime.uid), 'Requested root either observes UID0 or reports failure/uncertainty; no App-identity downgrade');
    if (rootVerified) await stop(owner, root.id);
    else if (rootResult.observedUid === undefined && (await host.logs(root.id, 'stderr', -1, 4096)).text?.toLowerCase().includes('permission denied')) {
      assert(rootResult.state === 'failed' && !rootResult.processMaySurvive && rootResult.payloadAdmitted === false && rootResult.rootStartupDenied === true && rootResult.startupGateVersion === 1,
        'Actual root-manager denial is terminal only before the native payload admission gate');
      assert(await shell(`test ! -f ${quote(state.directory + '/root/launches')} || cat ${quote(state.directory + '/root/launches')}`) === '', 'Denied root launch executes no trusted payload side effect');
    }
    verified = true;
    evidence({ event: 'arxd-services-functional', verified, run: state.run, checks, firstPlanDurationMs: firstDuration, root: { successVerified: rootVerified, state: rootResult.state, requested: rootResult.identity, observedUid: rootResult.observedUid, reason: rootResult.reason }, info: owner.info, runtimeIdentity: runtime, capabilities: host.capabilities(), mode: 'offline-deterministic/real-android-pi-process-mcp' });
  } finally {
    const cleanupFailures = await cleanup(owner);
    try { await core.services!.mcp.setHttpPolicy(previousHttp); } catch (error) { cleanupFailures.push(String(error)); }
    if (verified && state.deletion) {
      await core.select(state.deletion.survivor);
      const capacity = await until(async () => (await core.refresh()).capacity, (value) => value.state === 'current', 'post-cleanup survivor capacity');
      state.deletion.capacity = { tokens: capacity.tokens, limit: capacity.limit, revision: capacity.revision };
      state.deletion.turns = core.getSnapshot().turns.map((turn) => turn.id); await save(state);
    }
    evidence({ event: 'arxd-services-cleanup', run: state.run, profile: state.profile, functionalVerified: verified, cleanupFailures });
  }
}

export async function startServicesCheckpoint(owner: Owner) {
  requireVerification();
  const { state, core } = owner; await core.model('test');
  if (state.profile === 'input') {
    const child = await owner.host.start(`input-setup-${state.run}`, definition(owner, 'echo'));
    await until(() => owner.host.inspect(child.id), (record) => record.state === 'running', 'input fixture');
    await core.send(serviceProbePrompt([{ name: 'process_input', args: { id: child.id, text: 'unsafe-input-once\n' } }]));
  } else if (state.profile === 'mcp') {
    state.httpPolicyBefore = core.services!.mcp.httpPolicy().allowPlaintextHttp; await save(state);
    await core.services!.mcp.setHttpPolicy(true); // Explicit trusted checkpoint acceptance opt-in.
    if (!state.externalUrl) throw new Error('MCP no-replay checkpoint needs an independent external fixture URL');
    const config = await core.services!.mcp.configure({ name: 'Independent surviving HTTP fixture', transport: 'http', enabled: true, url: state.externalUrl });
    state.serverId = config.id; state.serverIds.push(config.id); await save(state);
    await core.send(serviceProbePrompt([{ name: 'mcp_tools', args: { id: config.id } }, { name: { ref: '0.tools.1.alias' }, args: {} }]));
  } else await core.send(serviceProbePrompt([{ name: 'process_start', args: definition(owner, 'echo') }, { name: 'process_list', args: {} }]));
  throw new Error('Expected unsafe-operation checkpoint was not reached');
}
export async function resumeServicesCheckpoint(owner: Owner) {
  requireVerification();
  const { state, core } = owner;
  if (owner.info.processId === state.startedPid) throw new Error('Recovery requires an actual new Android process');
  await core.harness.waitForIdle(BACKGROUND_CONTEXT); await core.refresh();
  const tools = core.getSnapshot().turns.flatMap((turn) => turn.tools);
  const interrupted = tools.filter((tool) => tool.isError && /interrupt|partially|restart|unavailable/i.test(tool.text));
  if (state.profile !== 'result' && !interrupted.length) throw new Error('Pending unsafe tool did not retain an explicit interrupted outcome');
  const launches = await shell(`test ! -f ${quote(state.directory + '/launches')} || cat ${quote(state.directory + '/launches')}`);
  const inputs = await shell(`test ! -f ${quote(state.directory + '/inputs')} || cat ${quote(state.directory + '/inputs')}`);
  const expectedLaunches = state.profile === 'intent' || state.profile === 'mcp' ? '' : '1';
  if (launches !== expectedLaunches || state.profile === 'input' && inputs !== '1') throw new Error('Unsafe native effect was duplicated or lost: ' + JSON.stringify({ launches, inputs, expectedLaunches }));
  const records = await Promise.all(state.processIds.map((id) => owner.host.inspect(id)));
  if (records.some((record) => ['queued', 'starting', 'running'].includes(record.state))) throw new Error('Reopening automatically restarted or falsely adopted an old service');
  evidence({ event: 'arxd-services-recovered', verified: true, run: state.run, profile: state.profile, launches: launches || '0', inputs: inputs || '0', interruptedTools: interrupted.map((tool) => tool.name), oldPid: state.startedPid, processId: owner.info.processId, records: records.map((record) => ({ id: record.id, state: record.state, processMaySurvive: record.processMaySurvive, reason: record.reason })), mode: 'fresh-process/actual-pi-unsafe-recovery' });
  if (state.profile === 'mcp') await core.services!.mcp.setHttpPolicy(state.httpPolicyBefore ?? false);
  evidence({ event: 'arxd-services-cleanup', run: state.run, profile: state.profile, cleanupFailures: await cleanup(owner) });
}
export async function backgroundServices(owner: Owner, finish: boolean) {
  requireVerification();
  const { state, core } = owner;
  if (!finish) {
    await core.model('test');
    const tools = await plan(owner, [{ name: 'process_start', args: definition(owner, 'http') }]); state.processId = String(JSON.parse(tools[0].text).id);
    const port = await until(() => shell(`test ! -f ${quote(state.directory + '/port')} || cat ${quote(state.directory + '/port')}`), (value) => /^\d+$/.test(value), 'managed HTTP listener');
    state.port = Number(port); await save(state);
    await closeServicesVerification(owner);
    evidence({ event: 'arxd-services-background-ready', verified: true, run: state.run, port: state.port, processId: state.processId, pid: owner.info.processId, info: owner.info, mode: 'actual-native-service/no-js-lifetime-promise' });
  } else {
    const current = await owner.host.inspect(state.processId!);
    if (current.state !== 'running') throw new Error('Foreground service did not retain the observed instance: ' + JSON.stringify(current));
    const requests = await shell(`cat ${quote(state.directory + '/requests')}`);
    if (Number(requests) < 2 || await shell(`cat ${quote(state.directory + '/launches')}`) !== '1') throw new Error('Background fixture did not serve requests from one retained instance');
    await stop(owner, state.processId!);
    evidence({ event: 'arxd-services-background-finished', verified: true, run: state.run, requests: Number(requests), launchCount: 1, processId: current.id, cleanupFailures: await cleanup(owner) });
  }
}

export async function closeServicesVerification(owner: Owner) {
  requireVerification();
  owners.delete(`${owner.state.run}-${owner.state.profile}`);
  await owner.core.close();
  if (owner.controls.watches !== 0 || owner.controls.watchStarts !== owner.controls.watchStops) throw new Error('Closing the owner leaked a native skill watcher');
  evidence({ event: 'arxd-services-owner-closed', run: owner.state.run, profile: owner.state.profile, verified: true, nativeSkillWatchers: owner.controls.watches });
}

/** Fault only the isolated package's owned registry/log paths; restore modes before returning. */
export async function storageFaultServices(owner: Owner) {
  requireVerification();
  const checks: string[] = []; const { state, host } = owner;
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  await host.list(0, 1); // Initialize the real native registry before denying writes.
  const admission = `storage-failure-${state.run}`;
  let rejected = false;
  try {
    await shell('chmod 500 "${ARXD_WORKSPACE%/workspace}/managed-processes"');
    try { await host.start(admission, definition(owner, 'echo')); } catch { rejected = true; }
  } finally { await shell('chmod 700 "${ARXD_WORKSPACE%/workspace}/managed-processes"'); }
  assert(rejected, 'Actual native registry persistence fails when its owned directory is not writable');
  const all = []; let offset: number | null = 0;
  while (offset !== null) { const page = await host.list(offset, 32); all.push(...page.items); offset = page.nextOffset; }
  assert(!all.some((record) => record.admissionId === admission), 'Failed persistence rolls back the in-memory admission; no dedupable queued record remains');
  assert(await shell(`test ! -f ${quote(state.directory + '/launches')} || cat ${quote(state.directory + '/launches')}`) === '', 'Failed admission did not execute its trusted fixture effect');
  const retried = await host.start(admission, definition(owner, 'echo'));
  await until(() => host.inspect(retried.id), (record) => record.state === 'running', 'explicit retry after restored storage');
  await until(() => shell(`test ! -f ${quote(state.directory + '/launches')} || cat ${quote(state.directory + '/launches')}`), (value) => value === '1', 'single explicit retry effect');
  checks.push('Explicit retry after repair starts exactly once'); await stop(owner, retried.id);
  const logging = await host.start(`log-failure-${state.run}`, definition(owner, 'echo', state.directory + '/log-failure'));
  await until(() => host.logs(logging.id, 'stdout', 0, 4096), (page) => page.text?.includes('prefix-✓') === true, 'log failure fixture readiness');
  try {
    await shell(`chmod 400 "\${ARXD_WORKSPACE%/workspace}/managed-processes/${logging.id}/stdout.ring"`);
    await host.write(logging.id, 'cause-log-storage-failure\n');
    const failed = await until(() => host.inspect(logging.id), (record) => !!record.ioError && ['failed', 'lost', 'exited'].includes(record.state), 'observable failed log append');
    assert(!!failed.ioError, 'Real log-write failure remains visible instead of dropping output silently');
  } finally { await shell(`chmod 600 "\${ARXD_WORKSPACE%/workspace}/managed-processes/${logging.id}/stdout.ring"`); }
  assert(await shell(`cat ${quote(state.directory + '/log-failure/launches')}`) === '1', 'A reader/storage failure does not automatically restart the process');
  evidence({ event: 'arxd-services-storage', verified: true, run: state.run, checks, fault: 'owned-registry-dir-0500/owned-log-0400', cleanupFailures: await cleanup(owner) });
}

export { reopenServiceDeletion };
