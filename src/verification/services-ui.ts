import { requireVerification } from './access';
import Constants from 'expo-constants';
import Rxd from '../../modules/rxd';
import { getAndroidWorkspace } from '../workspace/android';
import { NativeServices } from '../workspace/native-services';
import type { ProcessRecord } from '../workspace/service-types';
import { publishEvidence } from './evidence';

type State = { run: string; directory: string; processFixture: string; mcpFixture: string; processIds: string[]; serverIds: string[] };
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read-only observations accompany actual production-page interaction. Only
 * ownership metadata stays in fixture files; no process/config is created by this route. */
export async function serviceUiStage(run: string, stage: string, packageName: string, nonce: string) {
  requireVerification();
  if (!/^[a-f0-9]{16}$/.test(run) || !/^[a-f0-9]{16}$/.test(nonce) || !/^art\.tsingshui\.arxd\.[a-z][a-z0-9_]*$/.test(packageName) || Constants.expoConfig?.android?.package !== packageName) throw new Error('Service UI acceptance requires the exact isolated package');
  const runtime = await Rxd.prepareTermux();
  if (runtime.packageName !== packageName || runtime.debuggable !== false) throw new Error('Isolated non-debuggable Android runtime identity mismatch');
  const host = { pid: Number(runtime.pid), uid: Number(runtime.uid) };
  if (!Number.isSafeInteger(host.pid) || host.pid <= 1 || !Number.isSafeInteger(host.uid) || host.uid < 10000) throw new Error('Invalid isolated host identity');
  const core = await getAndroidWorkspace(), services = core.services;
  if (!services) throw new Error('Native services unavailable');
  const file = `.services-ui-${run}.json`, prefix = `ui-${run}-`;
  async function all() {
    const records: ProcessRecord[] = [];
    let offset: number | null = 0;
    while (offset !== null) { const page = await services!.processes.list(offset, 32); records.push(...page.items); offset = page.nextOffset; }
    return records;
  }
  async function shell(script: string) { const result = await Rxd.runTermux(script, 10000); if (result.exitCode !== 0) throw new Error('UI fixture observation failed: ' + result.stderr.slice(0, 300)); return result.stdout.trim(); }
  async function save(state: State) { const old = await Rxd.readFile('workspace', file).catch(() => undefined); await Rxd.writeFile('workspace', file, JSON.stringify(state), old?.sha256 ?? ''); }
  if (stage === 'setup') {
    const existing = await all();
    if (existing.some((record) => ['queued', 'starting', 'running', 'stopping', 'lost'].includes(record.state) || record.processMaySurvive)) throw new Error('Isolated package has existing active/uncertain services; do not run Stop All acceptance');
    await Rxd.createDirectory('workspace', `arxd-services-ui-${run}`);
    const state: State = { run, directory: await shell(`printf '%s' "$ARXD_WORKSPACE/arxd-services-ui-${run}"`), processFixture: await NativeServices.fixture('process-fixture.py'), mcpFixture: await NativeServices.fixture('mcp-fixture.py'), processIds: [], serverIds: [] };
    await save(state);
    publishEvidence(JSON.stringify({ event: 'arxd-services-ui-stage', stage, run, nonce, verified: true, host, fixture: state, mode: 'actual-production-pages/isolated-android-package' })); return;
  }
  const state = JSON.parse((await Rxd.readFile('workspace', file)).text!) as State;
  const expected = await shell(`printf '%s' "$ARXD_WORKSPACE/arxd-services-ui-${run}"`);
  if (state.run !== run || state.directory !== expected || state.processIds.length > 16 || state.serverIds.length > 16 || [...state.processIds, ...state.serverIds].some((id) => !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Invalid owned UI fixture state');
  let records = await all();
  const own = records.filter((record) => record.name.startsWith(prefix));
  for (const record of own) if (!state.processIds.includes(record.id)) state.processIds.push(record.id);
  const mcps = (await services.mcp.list()).filter((record) => record.name.startsWith(prefix));
  for (const record of mcps) if (!state.serverIds.includes(record.id)) state.serverIds.push(record.id);
  await save(state);
  if (stage === 'cleanup') {
    const failures: string[] = [];
    const configurations = await services.mcp.list();
    for (const id of state.serverIds) { try {
      if (!configurations.some((record) => record.id === id && record.name.startsWith(prefix))) throw new Error('MCP fixture ownership differs');
      await services.mcp.remove(id);
    } catch (error) { failures.push(String(error)); } }
    for (const id of state.processIds) {
      try {
        const current = records.find((record) => record.id === id);
        if (!current || !current.name.startsWith(prefix)) throw new Error('Fixture ownership differs');
        if (!['exited', 'failed'].includes(current.state) || current.processMaySurvive) await services.processes.stop(id);
        const stopped = await services.processes.inspect(id);
        if (!['exited', 'failed'].includes(stopped.state) || stopped.processMaySurvive) throw new Error('Owned fixture termination unverified');
        await services.processes.remove(id);
      } catch (error) { failures.push(`${id}: ${String(error)}`); }
    }
    publishEvidence(JSON.stringify({ event: 'arxd-services-ui-stage', stage, run, nonce, verified: failures.length === 0, failures })); return;
  }
  if (stage === 'stopped') {
    for (let i = 0; i < 200; i++) {
      records = await all();
      if (state.processIds.every((id) => records.some((record) => record.id === id && record.state === 'exited' && !record.processMaySurvive))) break;
      await sleep(100);
    }
  } else if (stage !== 'observe') throw new Error('Unsupported service UI stage');
  const processes = records.filter((record) => state.processIds.includes(record.id));
  const foreignActive = records.filter((record) => !state.processIds.includes(record.id) && (['queued', 'starting', 'running', 'stopping', 'lost'].includes(record.state) || record.processMaySurvive)).map((record) => record.id);
  const counters: Record<string, string> = {};
  for (const suffix of ['echo', 'http', 'stdio', ...['life_activity', 'life_host', 'life_userstop', 'life_force'].filter((suffix) => processes.some((record) => record.name === prefix + suffix))]) for (const name of ['launches', 'initializations', 'inputs', 'port']) counters[`${suffix}/${name}`] = await shell(`test ! -f ${quote(`${state.directory}/${suffix}/${name}`)} || cat ${quote(`${state.directory}/${suffix}/${name}`)}`);
  const logs: Record<string, string | null | undefined> = {};
  for (const process of processes) if (!process.protocolOwner) logs[process.name] = (await services.processes.logs(process.id, 'stdout', 0, 8192)).text;
  const identities: Record<string, string> = {};
  if (stage === 'stopped') {
    if (foreignActive.length || processes.length !== state.processIds.length || processes.some((record) => record.state !== 'exited' || record.processMaySurvive)) throw new Error('Notification action did not verify every owned instance terminated');
    for (const process of processes) if (process.pid) identities[process.id] = await shell(`if test -r /proc/${process.pid}/stat; then cat /proc/${process.pid}/stat; else printf absent; fi`);
  }
  publishEvidence(JSON.stringify({ event: 'arxd-services-ui-stage', stage, run, nonce, verified: true, host, processes, httpPolicy: services.mcp.httpPolicy(), mcps: await services.mcp.list().then((rows) => rows.filter((row) => state.serverIds.includes(row.id))), counters, logs, foreignActive, identities, fixture: state }));
}
