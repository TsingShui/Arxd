import { requireVerification } from './access';
import { publishEvidence } from './evidence';
import '../runtime';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { useLocalSearchParams } from 'expo-router';
import { AssistantEntry, DEFAULT_COMPACTION_POLICY, LiveDoc, UserEntry } from '@earendil-works/pi-durable';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { ConnectionHost } from '../workspace/connections';
import { openDatabaseAsync } from 'expo-sqlite';
import { fetch as expoFetch } from 'expo/fetch';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Rxd from '../../modules/rxd';
import { ArxdSqlite } from '../agent/sqlite';
import { safeRequestError } from '../agent/request-retry';
import { openWorkspace, type Workspace, type WorkspaceSnapshot } from '../workspace/core';
import { ResponseActivity } from '../ui/ResponseActivity';
import { palettes } from '../ui/theme';
import { androidServices } from '../workspace/native-services';
import { prepareRetryServices, verifyRetryServices, cleanupRetryServices } from './retry-services';

const endpoint = 'http://127.0.0.1:18759';
const cases: Record<string, (string | number)[]> = {
  responsesExhausted: ['reset', 'reset', 'reset', 'reset'], anthropicExhausted: ['reset', 'reset', 'reset', 'reset'], googleExhausted: ['reset', 'reset', 'reset', 'reset'], responseStopRace: ['race'], invalidModel: ['invalid-model'], invalidParameters: ['invalid-parameters'], quota: ['quota'], subsequentRequest: [400],
  network1: ['reset'], network2: ['reset', 'reset'], network3: ['reset', 'reset', 'reset'], exhausted: ['reset', 'reset', 'reset', 'reset'],
  partial: ['partial-reset'], partialExhausted: ['partial-reset', 'reset', 'reset', 'reset'], fragments: ['partial-tool-reset'], malformed: ['malformed'], incomplete: ['clean-incomplete'],
  toolNoReplay: ['tool', 'reset'], serviceNoReplay: ['process-tool', 'discover-tool', 'mcp-tool', 'reset'], toolFailure: ['failed-tool'], diagnostic: ['diagnostic'], configGuard: ['reset'], certificate: [], tlsClose: [], invalidEndpoint: [], overflow: ['overflow'], compactionNetwork: [], compactionHttp: [], compactionConcurrent: ['ok', 'reset', 'reset'], compactionBlocking: [], compactionBackground: [],
  http503zero: ['http503zero'], nativeProtocol: ['bad-chunk'], emptyError: [], unknown: [], refused: [], dns: [],
  configuredNativeDeadline: ['stall', 'stall', 'stall', 'stall'], configuredDeadline: ['stall', 'stall', 'stall', 'stall'], configuredDeadlineStop: ['stall'],
  networkThen401: ['reset', 401], activeStop: ['stall'], deadline: ['stall'], streamingDeadline: ['partial-stall'], deadlineExhausted: ['stall', 'stall', 'stall', 'stall'], interrupted: ['stall'],
  ...Object.fromEntries([400, 401, 403, 404, 429, 500, 503].map((status) => [`http${status}`, [status]])),
};

type NativeTransportDiagnostic = { attempt: number; at: number; chain: { name?: string; code?: string; message?: string; nativeClasses?: string[] }[]; truncated: boolean; cycle: boolean };

/** Controlled fixture errors only: never inspect request headers/body or stacks.
 * Capture before SDK normalization hides the bounded native exception marker. */
function nativeTransportDiagnostic(error: unknown, attempt: number): NativeTransportDiagnostic {
  const value: NativeTransportDiagnostic = { attempt, at: Date.now(), chain: [], truncated: false, cycle: false };
  const seen = new Set<unknown>();
  let current = error;
  const text = (item: unknown, limit: number) => typeof item === 'string' || typeof item === 'number' ? safeRequestError(String(item), ['sk-fixture-secret-never-display']).slice(0, limit) : undefined;
  for (let index = 0; current !== undefined && current !== null && index < 4; index++) {
    if (seen.has(current)) { value.cycle = true; break; }
    seen.add(current);
    const node = current;
    const field = (key: string): unknown => { try { return typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined; } catch { return undefined; } };
    const message = text(typeof current === 'string' ? current : field('message'), 1000);
    const native = message?.match(/Arxd model transport \[([A-Za-z0-9_.$,]{1,1024})\]:/)?.[1].split(',').slice(0, 4).map((name) => name.slice(0, 160));
    const name = text(field('name'), 120), code = text(field('code'), 120);
    value.chain.push({ ...(name ? { name } : {}), ...(code ? { code } : {}), ...(message ? { message } : {}), ...(native?.length ? { nativeClasses: native } : {}) });
    current = field('cause');
  }
  value.truncated = !value.cycle && current !== undefined && current !== null;
  return value;
}

/** Android-only acceptance route: actual Pi/AI/Expo fetch and native SQLite.
 * No provider credentials and no changes to the user's workspace/configuration.
 * The visible response uses the same conversation ResponseActivity component. */
export default function RetryVerification() {
  const params = useLocalSearchParams<{ case?: string; run?: string; resume?: string; stop?: string }>();
  const [value, setValue] = useState<WorkspaceSnapshot>();
  const [status, setStatus] = useState('Deterministic Android network fixture');
  const started = useRef(false);
  useEffect(() => {
    requireVerification();
    if (started.current) return;
    started.current = true;
    const name = params.case ?? 'network1';
    const run = params.run ?? 'manual';
    if (!(name in cases) || !/^[a-zA-Z0-9_-]{1,80}$/.test(run)) { void Promise.resolve().then(() => setStatus('Invalid fixture case/run')); return; }
    const id = `${run}-${name}`;
    const nativeTransportScenario = name === 'dns' ? 'reserved-hostname/native-transport; DNS resolution failure is not assumed' : name === 'tlsClose' ? 'controlled-loopback-TLS-ClientHello-EOF' : undefined;
    let core: Workspace | undefined;
    let unsub: (() => void) | undefined;
    let serviceFixture: Awaited<ReturnType<typeof prepareRetryServices>> | undefined;
    const nativeDiagnostics: NativeTransportDiagnostic[] = [];
    const toolFailureRequests: { taskId: string; attempt: number }[] = [];
    let toolFailureRecoveryObserved = false;
    void (async () => {
      const db = await openDatabaseAsync(`arxd-retry-${id}.sqlite`);
      await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const database = new ArxdSqlite(db);
      const info = await Rxd.getInfo();
      const nativeAttempts: number[] = [];
      const nativeAborts: number[] = [];
      let configuredStopScheduled = false;
      let jsBlocked: { start: number; end?: number } | undefined;
      const configured = name.startsWith('configured');
      const protocol = name === 'responsesExhausted' ? 'openai-responses' : name === 'anthropicExhausted' ? 'anthropic-messages' : name === 'googleExhausted' ? 'google-generative-ai' : undefined;
      // Persist only an ID marker in this fixture's private database. The fake
      // key is trusted test data, reconstructed on reopen; no user secret store.
      if (protocol === 'google-generative-ai') await database.exec('CREATE TABLE IF NOT EXISTS arxd_retry_fixture_keys (id TEXT PRIMARY KEY)');
      const credentials: ConnectionHost | undefined = protocol === 'google-generative-ai' ? {
        get: async (id) => await database.get('SELECT id FROM arxd_retry_fixture_keys WHERE id=?', id) ? { apiKey: 'sk-fixture-secret-never-display' } : undefined,
        put: async (id, value) => { if (value.apiKey !== 'sk-fixture-secret-never-display' || value.headers) throw new Error('Only the trusted fixture key is supported'); await database.run('INSERT OR REPLACE INTO arxd_retry_fixture_keys (id) VALUES (?)', id); },
        remove: async (id) => { await database.run('DELETE FROM arxd_retry_fixture_keys WHERE id=?', id); },
      } : undefined;
      const fetch: typeof globalThis.fetch = (input, init) => {
        nativeAttempts.push(Date.now());
        if (name === 'configuredNativeDeadline' && !jsBlocked) {
          jsBlocked = { start: 0 };
          setTimeout(() => { jsBlocked!.start = Date.now(); publishEvidence(JSON.stringify({ event: 'arxd-retry-js-block', id, start: jsBlocked!.start })); const until = Date.now() + 3000; while (Date.now() < until) { /* Deliberately suspend JS timers; native must cancel independently. */ } jsBlocked!.end = Date.now(); }, 100);
        }
        init?.signal?.addEventListener('abort', () => nativeAborts.push(Date.now()), { once: true });
        if (name === 'configuredDeadlineStop' && !configuredStopScheduled) { configuredStopScheduled = true; setTimeout(() => { void core?.stop(); }, 250); }
        if (name === 'emptyError') throw new Error('');
        if (name === 'unknown') throw new TypeError('Fixture internal TypeError is not a network failure');
        const url = name === 'tlsClose' ? `https://127.0.0.1:18762/${id}/chat/completions` : name === 'certificate' ? `https://127.0.0.1:18760/${id}/chat/completions` : name === 'refused' ? 'http://127.0.0.1:18761/never-listening' : name === 'dns' ? 'https://arxd-network-fixture.invalid/never-resolves' : `${endpoint}/${id}/chat/completions`;
        const dispatch = () => expoFetch(configured || protocol ? input : url, init) as unknown as Promise<Response>;
        const dispatched = name === 'toolFailure' ? (async () => {
          if (!core) throw new Error('Tool-failure fixture runtime is unavailable');
          const generation = (await core.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => task.record.kind === 'pi.generation' && task.record.state.status === 'running');
          if (generation.length !== 1) throw new Error('Expected one current model generation at the actual fetch boundary');
          const live = await core.harness.snapshot(LiveDoc, generation[0].record.conversationId, BACKGROUND_CONTEXT);
          if (!live?.generation || live.run?.taskId !== generation[0].record.id) throw new Error('Actual model generation attempt is unavailable');
          toolFailureRequests.push({ taskId: String(generation[0].record.id), attempt: live.generation.attempt });
          return dispatch();
        })() : dispatch();
        const operation = ['dns', 'certificate', 'refused', 'tlsClose'].includes(name) ? dispatched.catch((error: unknown) => {
          if (nativeDiagnostics.length < 4) {
            try {
              const diagnostic = nativeTransportDiagnostic(error, nativeAttempts.length);
              nativeDiagnostics.push(diagnostic);
              publishEvidence(JSON.stringify({ event: 'arxd-retry-native-transport', id, case: name, diagnostic, credentialValuesIncluded: false }));
            } catch { /* Diagnostics must not replace or reclassify the original failure. */ }
          }
          throw error;
        }) : dispatched;
        return name === 'responseStopRace' ? operation.then((response) => { void core?.stop(); return response; }) : operation;
      };
      core = await openWorkspace(database, {
        info,
        probe: async (script: string, timeoutMs: number) => {
          const result = await Rxd.runTermux(script, timeoutMs);
          if (result.exitCode !== 0) throw new Error(result.stderr || `rxd probe exit ${result.exitCode}`);
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
        },
        live: { getKey: async () => 'sk-fixture-secret-never-display', fetch },
        ...(credentials ? { credentials } : {}),
        ...(name === 'serviceNoReplay' ? { services: androidServices } : {}),
        shell: { run: (call, script, timeout) => { Rxd.registerShell(`retry-${id}-${call}`); return Rxd.runShell(`retry-${id}-${call}`, script, timeout); }, cancel: (call) => Rxd.cancelShell(`retry-${id}-${call}`), progress: (call) => Rxd.shellProgress(`retry-${id}-${call}`) },
      });
      serviceFixture = name === 'serviceNoReplay' ? await prepareRetryServices(core, id, !!params.resume) : undefined;
      if (!params.resume) await expoFetch(`${endpoint}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, failures: cases[name], fixture: serviceFixture, tlsClose: name === 'tlsClose', compactionFailures: ['compactionHttp', 'compactionBlocking', 'compactionBackground'].includes(name) ? [401] : name.startsWith('compaction') ? ['reset'] : [] }) });
      if (name === 'invalidEndpoint') {
        let rejected = false;
        try { await core.connections.save({ name: 'Invalid endpoint fixture', preset: 'custom', protocol: 'openai-completions', endpoint: 'file:///never-model', auth: 'none' }); } catch { rejected = true; }
        if (!rejected || nativeAttempts.length || core.getSnapshot().busy) throw new Error('Invalid endpoint crossed the local configuration boundary');
        await publishEvidence(JSON.stringify({ event: 'arxd-retry-result', verified: true, id, case: name, status: 'configuration-rejected', requests: 0, failures: [], nativeAttempts, mode: 'real-android-public-configuration-boundary' }));
        setStatus('PASS invalid endpoint rejected before dispatch'); return;
      }
      let guardAttempt: Promise<void> | undefined;
      let guardRejected = 0;
      let retainedHistory: string[] = [];
      let stopStarted = false;
      unsub = core.subscribe((snapshot) => {
        setValue(snapshot);
        const turn = snapshot.turns.at(-1);
        if (name === 'toolFailure' && (turn?.recovery || turn?.phase === 'recovery')) toolFailureRecoveryObserved = true;
        void publishEvidence(JSON.stringify({ event: 'arxd-retry-progress', id, phase: turn?.phase, recovery: turn?.recovery, status: turn?.status, failures: turn?.requestErrors }));
        if (name === 'configGuard' && turn?.recovery && !guardAttempt && !params.resume) {
          guardAttempt = (async () => {
            for (const change of [() => core!.model('test'), () => core!.connections.save({ name: 'Forbidden during recovery', preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:18759/changed', auth: 'none' }), () => core!.connections.credential('deepseek', { apiKey: 'sk-fixture-edit-must-not-be-saved' })]) {
              try { await change(); } catch (error) { if (!/请先停止正在运行的任务|Stop the running task first/.test(String(error))) throw error; guardRejected++; }
            }
          })();
        }
        if (!stopStarted && ((params.stop && turn?.recovery?.attempt === Number(params.stop)) || (name === 'activeStop' && snapshot.busy))) {
          stopStarted = true;
          setTimeout(() => { void core?.stop(); }, name === 'activeStop' ? 500 : 0);
        }
      });
      if (!params.resume) {
        if (configured) {
          const connection = await core.connections.save({ name: 'Configured 1s deadline fixture', preset: 'custom', protocol: 'openai-completions', endpoint: `${endpoint}/${id}`, auth: 'none' });
          const model = await core.connections.manual(connection.id, { id: 'configured-deadline-model', name: 'Configured one-second model', contextWindow: 128000, maxTokens: 2048, thinking: ['off'] }, { timeoutMs: 1000, maxTokens: 64 }, true);
          await core.model(model.id);
        } else if (protocol) {
          const connection = await core.connections.save({ name: 'Retry ' + protocol + ' fixture', preset: 'custom', protocol, endpoint: `${endpoint}/${id}`, auth: protocol === 'google-generative-ai' ? 'key' : 'none' });
          if (protocol === 'google-generative-ai') await core.connections.credential(connection.id, { apiKey: 'sk-fixture-secret-never-display' });
          const model = await core.connections.manual(connection.id, { id: 'retry-model', name: 'Deterministic ' + protocol, contextWindow: 128000, maxTokens: 2048, thinking: ['off'] }, { maxTokens: 64 }, true);
          await core.model(model.id);
        } else await core.model('deepseek');
        await core.send('Deterministic Android retry acceptance.');
        if (name === 'subsequentRequest') {
          const failed = core.getSnapshot().turns.at(-1);
          if (failed?.status !== 'failed' || failed.requestErrors?.length !== 1 || failed.requestErrors[0].status !== 400) throw new Error('Explicit follow-up fixture did not first settle its terminal request');
          await core.send('A separate explicit user request after the failed request.');
        }
        if (name.startsWith('compaction')) {
          const current = await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT);
          if (!current) throw new Error('Missing compaction conversation');
          await current.commit(async (tx) => {
            for (let index = 0; index < 3; index++) await tx.appendEntry(UserEntry, current.id, { model: [{ role: 'user', content: 'deterministic-compaction-history-' + index + ':' + 'history '.repeat(name === 'compactionBlocking' ? 190000 : name === 'compactionBackground' ? 140000 : 14000), timestamp: Date.now() }] });
          }, BACKGROUND_CONTEXT);
          retainedHistory = (await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items.map((entry) => String(entry.id));
          if (name === 'compactionBackground') {
            const view = await current.context(BACKGROUND_CONTEXT);
            const tokens = view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
            const model = core.getSnapshot().models.find((model) => model.id === core!.getSnapshot().model);
            const blocking = (model?.context ?? 0) - DEFAULT_COMPACTION_POLICY.reserveTokens;
            const background = blocking - DEFAULT_COMPACTION_POLICY.backgroundTokens;
            if (tokens <= background || tokens >= blocking) throw new Error(`Background fixture is outside its actual threshold band: ${tokens}/${background}/${blocking}`);
          }
          const compacting = name === 'compactionBlocking' || name === 'compactionBackground' ? core.send('Generate after threshold compaction.') : core.compact();
          if (name === 'compactionConcurrent') await core.send('Independent generation while compaction recovers.');
          try { await compacting; if (name === 'compactionHttp') throw new Error('HTTP compaction unexpectedly succeeded'); }
          catch (error) {
            const settled = await core.refresh();
            if (!['compactionHttp', 'compactionBlocking'].includes(name) || !settled.compactionError) throw error;
            if (name === 'compactionHttp' && !settled.requestRecords?.some((record) => record.failure?.stage === 'compaction' && record.failure.category === 'http' && record.failure.status === 401 && record.failure.attempt === 1)) throw error;
          }
          await core.harness.waitForIdle(BACKGROUND_CONTEXT);
          const after = (await current.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items;
          if (retainedHistory.some((id) => !after.some((entry) => String(entry.id) === id))) throw new Error('Compaction failure/recovery erased original committed history');
        }
      }
      else { await core.harness.waitForIdle(BACKGROUND_CONTEXT); await core.refresh(); }
      await core.harness.waitForIdle(BACKGROUND_CONTEXT);
      await guardAttempt;
      let backgroundCompactionEvidence: unknown;
      if (name === 'compactionBackground') {
        const tasks = await core.harness.commit((tx) => tx.scanTasks({ conversationId: core!.getSnapshot().active!, kind: 'pi.compaction' }, 4), BACKGROUND_CONTEXT);
        const task = tasks.items[0];
        if (tasks.next || tasks.items.length !== 1 || !task.background) throw new Error('Fixture did not start one actual background compaction');
        const receipt = await core.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
        if (receipt.state.outcome.status !== 'failed') throw new Error('Background HTTP fixture did not retain its own failed outcome');
        backgroundCompactionEvidence = { taskId: String(task.id), background: task.background, outcome: receipt.state.outcome.status };
      }
      const snapshot = await core.refresh();
      setValue(snapshot);
      let evidence = await (await expoFetch(`${endpoint}/evidence`)).json() as Record<string, { requests: { at: number; stage: string; internalMarkerLeaked: boolean; disconnectedAt?: number; failedAt?: number; body: unknown }[]; tlsConnectionCount?: number; tlsConnections?: { at: number; failedAt?: number; disconnectedAt?: number; clientHello: boolean }[] }>;
      if ((configured || ['deadline', 'streamingDeadline', 'deadlineExhausted'].includes(name)) && !params.resume) for (let poll = 0; poll < 10 && evidence[id].requests.slice(0, ['deadline', 'streamingDeadline'].includes(name) ? 1 : undefined).some((request) => !request.disconnectedAt); poll++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        evidence = await (await expoFetch(`${endpoint}/evidence`)).json() as typeof evidence;
      }
      const allRequests = evidence[id].requests;
      const requests = name.startsWith('compaction') ? allRequests.filter((request) => request.stage === 'compaction') : allRequests;
      if (allRequests.some((request) => request.internalMarkerLeaked)) throw new Error('Native one-shot request policy did not remove its internal marker');
      const turn = snapshot.turns.at(-1);
      if (!turn) throw new Error('Missing fixture turn');
      const expected = ['emptyError', 'unknown', 'refused', 'dns', 'certificate', 'tlsClose'].includes(name) ? 0 : name === 'serviceNoReplay' ? 5 : name === 'toolNoReplay' ? 3 : ['compactionHttp', 'compactionBlocking', 'compactionBackground'].includes(name) ? 1 : name.startsWith('http') || ['nativeProtocol', 'malformed', 'incomplete', 'overflow', 'diagnostic', 'responseStopRace', 'invalidModel', 'invalidParameters', 'quota'].includes(name) ? 1 : name === 'networkThen401' ? 2 : name === 'network2' ? 3 : ['network3', 'exhausted', 'partialExhausted', 'responsesExhausted', 'anthropicExhausted', 'googleExhausted'].includes(name) ? 4 : 2;
      if (!params.stop && !['configuredNativeDeadline', 'configuredDeadline', 'configuredDeadlineStop', 'activeStop', 'deadline', 'streamingDeadline', 'deadlineExhausted', 'interrupted'].includes(name) && requests.length !== expected) throw new Error(`Expected ${expected} attempts, received ${requests.length}`);
      if (!name.startsWith('compaction') && snapshot.turns.length !== (name === 'subsequentRequest' ? 2 : 1)) throw new Error('Retry duplicated user submission');
      if (['network1', 'network2', 'network3', 'partial', 'fragments', 'configGuard', 'serviceNoReplay', 'subsequentRequest'].includes(name) && !params.stop) {
        if (turn.status !== 'done' || turn.answer !== 'RECOVERED_FIXTURE_ANSWER') throw new Error('Recovery did not produce one coherent final answer');
      }
      if (['nativeProtocol', 'malformed', 'incomplete', 'overflow', 'emptyError', 'unknown'].includes(name) && turn.status !== 'failed') throw new Error('Non-network failure did not terminate');
      if (['emptyError', 'nativeProtocol'].includes(name) && (turn.requestErrors?.length !== 1 || turn.requestErrors[0].retryable || !turn.requestErrors[0].message.trim())) throw new Error('Blank/protocol failure lost its terminal nonempty diagnostic');
      if (['partial', 'partialExhausted'].includes(name) && (!turn.activities.some((block) => block.kind === 'thinking' && block.text.includes('INTERRUPTED_FIXTURE_THINKING')) || !turn.activities.some((block) => block.kind === 'text' && block.text.includes('INTERRUPTED_FIXTURE_PREFIX')))) throw new Error('Failed stream did not retain both thinking and text');
      if (name === 'partialExhausted' && !turn.activities.some((block) => block.kind === 'request-error' && block.partial)) throw new Error('Partial response hid its explicit failed-attempt record');
      if (name.startsWith('http') && (!turn.requestErrors?.[0]?.message.includes(name.slice(4).replace('zero', '')) || turn.status !== 'failed')) throw new Error('HTTP error status not retained');
      if (name === 'partialExhausted' && (turn.requestErrors?.length !== 4 || !turn.requestErrors.every((failure) => failure.category === 'network' && !!failure.message.trim()))) throw new Error('Typed native stream reset did not preserve four concrete network failures');
      if (!params.stop && ['exhausted', 'partialExhausted', 'responsesExhausted', 'anthropicExhausted', 'googleExhausted'].includes(name) && !turn.requestErrors?.at(-1)?.message.includes('three retries exhausted')) throw new Error('Missing exhausted failure');
      if (name === 'unknown' && (turn.requestErrors?.length !== 1 || turn.requestErrors[0].retryable)) throw new Error('Arbitrary TypeError entered network retry');
      if (['refused', 'dns', 'tlsClose'].includes(name) && (turn.requestErrors?.length !== 4 || !turn.requestErrors.every((failure) => failure.category === 'network'))) throw new Error('Native connection failure did not follow four-attempt bound');
      if (name === 'tlsClose' && (evidence[id].tlsConnectionCount !== 4 || evidence[id].tlsConnections?.length !== 4 || !evidence[id].tlsConnections.every((connection) => connection.clientHello && connection.failedAt !== undefined) || (!params.resume && (nativeAttempts.length !== 4 || nativeDiagnostics.length !== 4)))) throw new Error('Controlled TLS EOF was not observed exactly four times through real ClientHello connections');
      if (name === 'toolNoReplay') {
        if (turn.tools.length !== 1 || turn.tools[0].isError || (await Rxd.readFile('workspace', `arxd-retry-${id}-count`)).text !== '1') throw new Error('Completed tool replayed during model retry');
      }
      let serviceEvidence: unknown;
      if (serviceFixture) {
        try { serviceEvidence = await verifyRetryServices(core, id, serviceFixture, !!params.resume); }
        catch (error) { await cleanupRetryServices(core, serviceFixture); throw error; }
        if (params.resume) await cleanupRetryServices(core, serviceFixture);
      }
      if (protocol && (turn.status !== 'failed' || turn.requestErrors?.length !== 4 || !turn.requestErrors.every((failure) => failure.category === 'network' && failure.stage === 'generation'))) throw new Error('Provider SDK multiplied or lost the single durable retry budget');
      if (name === 'responseStopRace' && (snapshot.busy || turn.recovery || !['done', 'stopped'].includes(turn.status) || (turn.requestErrors ?? []).some((failure) => failure.category !== 'cancelled'))) throw new Error('Response/Stop race produced duplicate/late work or failed recovery state');
      let toolFailureEvidence: unknown;
      if (name === 'toolFailure') {
        const tool = turn.tools[0];
        const output = tool ? JSON.parse(tool.text) as { exitCode?: number; stdout?: string; stderr?: string } : undefined;
        const activity = turn.activities.find((block) => block.kind === 'tool' && block.callId === tool?.id);
        if (turn.tools.length !== 1 || tool?.name !== 'shell' || !tool.isError || output?.exitCode !== 37 || output.stdout !== 'trusted-tool-failure 1\n' || output.stderr !== '' || activity?.kind !== 'tool' || activity.state !== 'error' || !activity.result?.isError || (await Rxd.readFile('workspace', `arxd-retry-${id}-failed-count`)).text !== '1') throw new Error('Expected exactly one visible shell error with exit37 and one fsynced side effect');
        // The projector deliberately keeps a failed-tool turn failed even after
        // a successful model continuation. Prove the two model rounds separately.
        const current = await core.harness.conversation(snapshot.active!, BACKGROUND_CONTEXT);
        const history = await current?.entries({ order: 'ascending' }, 16, undefined, BACKGROUND_CONTEXT);
        const replies = history?.items.filter(AssistantEntry.is).flatMap((entry) => (entry.model ?? []).filter((message) => message.role === 'assistant').map((message) => ({ taskId: String(entry.byTaskId), stopReason: message.stopReason }))) ?? [];
        const messages = requests.map((request) => (request.body as { messages?: { role?: string; content?: string; tool_call_id?: string }[] }).messages?.at(-1));
        const forwarded = messages[1]?.content ? JSON.parse(messages[1].content) as typeof output : undefined;
        if (history?.next || replies.length !== 2 || replies[0].stopReason !== 'toolUse' || replies[1].stopReason !== 'stop' || new Set(replies.map((reply) => reply.taskId)).size !== 2 || requests.length !== 2 || messages[0]?.role !== 'user' || messages[1]?.role !== 'tool' || messages[1].tool_call_id !== tool.id || forwarded?.exitCode !== 37 || forwarded.stdout !== output.stdout || forwarded.stderr !== '') throw new Error('Tool failure did not reach one ordinary successful model continuation');
        if (snapshot.busy || turn.status !== 'failed' || turn.answer !== 'RECOVERED_FIXTURE_ANSWER' || turn.requestErrors?.length || turn.recovery || toolFailureRecoveryObserved) throw new Error('Failed-tool turn lost its error status or entered model-network recovery');
        if (!params.resume && (nativeAttempts.length !== 2 || toolFailureRequests.length !== 2 || toolFailureRequests.some((request, index) => request.attempt !== 1 || request.taskId !== replies[index].taskId))) throw new Error('Ordinary model rounds did not each dispatch their own first attempt once');
        if (params.resume && (nativeAttempts.length || toolFailureRequests.length)) throw new Error('Reopening the failed-tool turn dispatched another model request');
        toolFailureEvidence = { exitCode: output.exitCode, toolState: activity.state, turnStatus: turn.status, replies, modelAttempts: toolFailureRequests, ordinaryRequests: requests.length, recoveryObserved: toolFailureRecoveryObserved };
      }
      if (name === 'certificate' && (turn.status !== 'failed' || turn.requestErrors?.length !== 1 || turn.requestErrors[0].category !== 'certificate' || turn.requestErrors[0].retryable || (!params.resume && nativeAttempts.length !== 1))) throw new Error('Actual untrusted model TLS endpoint was retried or lost certificate classification');
      if (['invalidModel', 'invalidParameters', 'quota'].includes(name)) {
        const reason = name === 'invalidModel' ? 'invalid model' : name === 'invalidParameters' ? 'invalid parameters' : 'quota exhausted';
        if (turn.status !== 'failed' || turn.requestErrors?.length !== 1 || turn.requestErrors[0].status !== (name === 'quota' ? 429 : 400) || !turn.requestErrors[0].message.includes(reason)) throw new Error('Terminal provider configuration/quota meaning was lost');
      }
      if (name === 'subsequentRequest' && (snapshot.turns[0].status !== 'failed' || snapshot.turns[0].requestErrors?.length !== 1)) throw new Error('Explicit follow-up erased the original durable failure');
      if (name === 'diagnostic') {
        const failure = turn.requestErrors?.[0];
        if (turn.status !== 'failed' || !failure || failure.status !== 400 || failure.requestId !== 'fixture-request-safe-159' || failure.providerCode !== 'fixture_400' || failure.message.length > 1000 || !failure.message.includes('[diagnostic truncated]')) throw new Error('Bounded HTTP diagnostics lost safe code/request ID/truncation');
      }
      if (name === 'networkThen401' && (turn.status !== 'failed' || turn.requestErrors?.length !== 2 || turn.requestErrors[0].category !== 'network' || turn.requestErrors[1].category !== 'http' || turn.requestErrors[1].status !== 401)) throw new Error('Later terminal response did not preserve independent causes');
      if (name === 'configGuard' && !params.resume && (guardRejected !== 3 || snapshot.model !== 'deepseek')) throw new Error('Recovery admitted configuration/model/credential changes');
      const comparable = name === 'toolNoReplay' ? requests.slice(1) : name === 'serviceNoReplay' ? requests.slice(3) : name.startsWith('compaction') || ['toolFailure', 'subsequentRequest'].includes(name) ? [] : requests;
      if (comparable.length > 1 && comparable.some((request) => JSON.stringify(request.body) !== JSON.stringify(comparable[0].body))) throw new Error('A retry changed captured context/model/generation request body');
      if (name === 'compactionConcurrent') {
        const generation = allRequests.filter((request) => request.stage === 'generation');
        const failures = snapshot.requestRecords?.filter((record) => record.failure) ?? [];
        const generationFailures = turn.requestErrors ?? [];
        if (generation.length !== 4 || generationFailures.length !== 2 || failures.length !== 1 || new Set([...failures.map((record) => record.failure!.id), ...generationFailures.map((failure) => failure.id)]).size !== 2 || !generationFailures.every((failure) => failure.category === 'network' && failure.stage === 'generation') || !failures.some((record) => record.failure?.stage === 'compaction')) throw new Error('Concurrent generation/compaction shared error identity or retry budget');
        const firstGenerationRetry = generation[2].at - generation[1].failedAt!;
        const secondGenerationRetry = generation[3].at - generation[2].failedAt!;
        if (firstGenerationRetry < .8 || secondGenerationRetry < 1.8) throw new Error('Concurrent generation recovery timers leaked');
      }
      if (name.startsWith('compaction')) {
        if (snapshot.requestRecords?.filter((record) => record.failure).length !== 1) throw new Error('Compaction failure ledger missing or duplicated');
        if (!['compactionHttp', 'compactionBlocking', 'compactionBackground'].includes(name) && snapshot.compactionError) throw new Error('Successful compaction did not clear active error');
        if (['compactionConcurrent', 'compactionBackground'].includes(name) && turn.status !== 'done') throw new Error('Compaction relabeled independent answer');
        if (name === 'compactionBackground' && (allRequests.filter((request) => request.stage === 'generation').length !== 2 || turn.requestErrors?.length || snapshot.turns[0]?.status !== 'done' || snapshot.turns[0]?.answer !== 'RECOVERED_FIXTURE_ANSWER')) throw new Error('Background compaction altered prior or independent successful generation');
      }
      if (name === 'compactionBlocking' && (turn.status !== 'failed' || allRequests.filter((request) => request.stage === 'generation').length !== 1)) throw new Error('Blocking compaction failure dispatched dependent request');
      if (name === 'fragments' && turn.tools.length) throw new Error('Incomplete tool fragment executed');
      let cancellationEvidence: unknown;
      if (params.stop) {
        const ordinal = Number(params.stop);
        const current = await core.harness.conversation(snapshot.active!, BACKGROUND_CONTEXT);
        const history = await current?.entries({ order: 'descending' }, 16, undefined, BACKGROUND_CONTEXT);
        const assistant = history?.items.find(AssistantEntry.is);
        const taskId = assistant?.byTaskId;
        const task = taskId === undefined ? undefined : await core.harness.commit((tx) => tx.task(taskId), BACKGROUND_CONTEXT);
        const failures = turn.requestErrors ?? [];
        if (![1, 2, 3].includes(ordinal) || requests.length !== ordinal || failures.length !== ordinal || !failures.every((failure, index) => failure.category === 'network' && failure.attempt === index + 1 && failure.id === String(task?.id)) || turn.activities.filter((block) => block.kind === 'request-error').length !== ordinal || snapshot.busy || turn.recovery) throw new Error('Backoff cancellation changed consumed attempts, causes, visibility or pending state');
        if (task?.kind !== 'pi.generation' || task.conversationId !== assistant?.conversationId || task.state.status !== 'terminal' || task.state.outcome.status !== 'aborted') throw new Error('Backoff Stop lacks the exact generation task cancellation receipt');
        if ((!params.resume && nativeAttempts.length !== ordinal) || (params.resume && nativeAttempts.length)) throw new Error('Backoff cancellation or reopen dispatched an extra model request');
        cancellationEvidence = { taskId: String(task.id), outcome: task.state.outcome.status, abortRequested: task.abortRequested, consumedAttempts: failures.map((failure) => failure.attempt), requestCount: requests.length };
      }
      if ((params.stop || name === 'activeStop' || name === 'configuredDeadlineStop') && turn.status !== 'stopped') throw new Error('Cancel did not settle as stopped');
      if ((turn.requestErrors ?? []).some((failure) => failure.message.length > 1000)) throw new Error('Composed diagnostic exceeded its durable/display bound');
      if (JSON.stringify(turn.requestErrors ?? []).includes('sk-fixture') || JSON.stringify(turn.requestErrors ?? []).includes('fixture-credential')) throw new Error('Error leaked fixture credentials');
      if (['deadline', 'streamingDeadline', 'deadlineExhausted'].includes(name)) {
        const exhausted = name === 'deadlineExhausted';
        const failed = turn.requestErrors ?? [];
        if (requests.length !== (exhausted ? 4 : 2) || turn.status !== (exhausted ? 'failed' : 'done') || failed.length !== (exhausted ? 4 : 1) || !failed.every((failure) => failure.category === 'timeout')) throw new Error('90s deadline did not produce the required timeout attempts and terminal outcome');
        const lifetimes = requests.slice(0, exhausted ? 4 : 1).map((request) => request.disconnectedAt === undefined ? Infinity : request.disconnectedAt - request.at);
        if (lifetimes.some((seconds) => seconds < 87 || seconds > 95)) throw new Error('90s native request lifetime was absent or outside deadline tolerance: ' + JSON.stringify(lifetimes));
        if (!exhausted && turn.answer !== 'RECOVERED_FIXTURE_ANSWER') throw new Error('Deadline recovery did not produce a distinct final answer');
        if (name === 'streamingDeadline' && (!turn.activities.some((block) => block.kind === 'request-error' && block.partial) || !turn.activities.some((block) => block.kind === 'text' && block.text.includes('INTERRUPTED_FIXTURE_PREFIX')))) throw new Error('Streaming deadline did not retain its interrupted partial separately');
        const totalLifetime = exhausted ? requests.at(-1)!.disconnectedAt! - requests[0].at : null;
        if (exhausted && (totalLifetime === null || totalLifetime < 360 || totalLifetime > 370 || (!params.resume && Date.now() - nativeAttempts[0] > 370000))) throw new Error('Finite 367s total request deadline violated');
      }
      if (['configuredDeadline', 'configuredNativeDeadline'].includes(name) && !params.resume) {
        if (requests.length !== 4 || turn.status !== 'failed' || turn.requestErrors?.length !== 4 || !turn.requestErrors.every((failure) => failure.category === 'timeout')) throw new Error('Configured 1s deadlines did not exhaust four timeout attempts');
        const lifetimes = requests.map((request) => request.disconnectedAt === undefined ? Infinity : request.disconnectedAt - request.at);
        if (lifetimes.some((seconds) => seconds < 0 || seconds > 4) || Date.now() - nativeAttempts[0] > 30000) throw new Error('Configured 1s deadline was replaced by the outer 90s guard');
      }
      if (name === 'configuredDeadlineStop' && !params.resume && (requests.length !== 1 || turn.status !== 'stopped' || turn.requestErrors?.some((failure) => failure.category !== 'cancelled'))) throw new Error('Explicit cancel was mistaken for a configured timeout');
      if (name === 'configuredNativeDeadline' && !params.resume) {
        const first = requests[0];
        const nativeLifetime = first.disconnectedAt === undefined ? Infinity : first.disconnectedAt - first.at;
        if (!jsBlocked?.end || jsBlocked.end - jsBlocked.start < 2900 || jsBlocked.start - nativeAttempts[0] > 500 || nativeLifetime > 2.5 || nativeLifetime < .5) throw new Error('Native request did not cancel during blocked JavaScript timers');
      }
      const timeline = name === 'tlsClose' ? evidence[id].tlsConnections ?? [] : requests;
      const gaps = timeline.slice(1).map((request, index) => request.at - timeline[index].at);
      // Receive-to-receive gaps include a stalled/streamed request's own duration.
      // Only the independent endpoint's failure/close -> next receipt measures wait.
      const backoffs = timeline.slice(1).map((request, index) => {
        const previous = timeline[index];
        const failedAt = previous.failedAt ?? previous.disconnectedAt;
        return failedAt === undefined ? null : request.at - failedAt;
      });
      if (!params.resume && !params.stop && !['toolNoReplay', 'serviceNoReplay', 'toolFailure', 'subsequentRequest'].includes(name)) for (const [index, wait] of backoffs.entries()) {
        if (wait === null || wait < [0.8, 1.8, 3.8][index]) throw new Error(`Independent backoff too short or missing: ${wait}`);
      }
      await publishEvidence(JSON.stringify({ event: 'arxd-retry-result', verified: true, id, case: name, requests: requests.length, gaps, backoffs, turns: snapshot.turns.length, status: turn.status, answer: turn.answer, failures: turn.requestErrors, activities: turn.activities, requestRecords: snapshot.requestRecords, nativeAttempts, nativeAborts, nativeDiagnostics, nativeConnections: name === 'tlsClose' ? evidence[id].tlsConnectionCount : undefined, nativeTransportScenario, jsBlocked, serviceEvidence, toolFailureEvidence, cancellationEvidence, backgroundCompactionEvidence, guardRejected, protocol, retainedHistory, configuredTimeoutMs: configured ? 1000 : undefined, mode: 'deterministic-fixture/real-android-pi-fetch-sqlite-ui' }));
      setStatus(`PASS ${name}: ${name === 'tlsClose' ? `${evidence[id].tlsConnectionCount} TLS connections` : `${requests.length} attempts`}`);
    })().catch(async (error) => { if (core && serviceFixture) { try { await cleanupRetryServices(core, serviceFixture); } catch (cleanup) { error = new Error(String(error) + '; owned cleanup failed: ' + String(cleanup)); } } setStatus(String(error)); await publishEvidence(JSON.stringify({ event: 'arxd-retry-result', verified: false, id, error: String(error), nativeDiagnostics, nativeTransportScenario, toolFailureRequests, toolFailureRecoveryObserved })); });
    return () => { unsub?.(); void core?.close(); };
    // One runtime per process; a fresh Android process validates persisted recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <SafeAreaView style={{ flex: 1, backgroundColor: palettes.fire.background }}><ScrollView contentContainerStyle={{ padding: 20 }}><Text selectable style={{ color: palettes.fire.accent, marginBottom: 20 }}>{status}</Text>{value?.turns.map((turn) => <ResponseActivity key={turn.id} turn={turn} c={palettes.fire} onTool={() => undefined} />)}</ScrollView></SafeAreaView>;
}
