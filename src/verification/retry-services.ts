import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import { androidServices, NativeServices } from '../workspace/native-services';
import type { ProcessDefinition } from '../workspace/service-types';
import { requireVerification } from './access';

type Fixture = { version: 1; directory: string; serverId: string; mcpProcessId: string; process: ProcessDefinition; processId?: string };
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function shell(script: string) {
  const result = await Rxd.runTermux(script, 15000);
  if (result.exitCode !== 0) throw new Error('Retry service fixture shell failed: ' + result.stderr.slice(0, 300));
  return result.stdout.trim();
}
async function save(id: string, value: Fixture) {
  const path = `.retry-services-${id}.json`, old = await Rxd.readFile('workspace', path).catch(() => undefined);
  await Rxd.writeFile('workspace', path, JSON.stringify(value), old?.sha256 ?? '');
}
/** Real workspace MCP configuration plus a later Pi-admitted process launch.
 * Both fixture payloads are package-owned; no arbitrary model script is added. */
export async function prepareRetryServices(core: Workspace, id: string, resume: boolean): Promise<Fixture> {
  requireVerification();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !core.services) throw new Error('Invalid isolated retry services fixture');
  if (resume) {
    const value = JSON.parse((await Rxd.readFile('workspace', `.retry-services-${id}.json`)).text!) as Fixture;
    if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.serverId) || !/^[a-f0-9-]{36}$/.test(value.mcpProcessId)) throw new Error('Invalid retry services state');
    return value;
  }
  await Rxd.prepareTermux();
  const directory = await shell('printf %s "$ARXD_WORKSPACE/arxd-retry-services-' + id + '"');
  const mcp = await NativeServices.fixture('mcp-fixture.py'), process = await NativeServices.fixture('process-fixture.py');
  const configured = await core.services.mcp.configure({ name: 'Retry counter', transport: 'stdio', enabled: true,
    launch: { name: 'Retry MCP counter', identity: 'app', argv: ['python', mcp, 'stdio', directory + '/mcp'] } });
  const started = await core.services.mcp.start(configured.id, 'retry-fixture/' + id);
  const fixture: Fixture = { version: 1, directory, serverId: configured.id, mcpProcessId: started.id,
    process: { name: 'Retry persistent process', identity: 'app', argv: ['python', process, 'echo', directory + '/process'] } };
  await save(id, fixture); return fixture;
}
export async function verifyRetryServices(core: Workspace, id: string, fixture: Fixture, resume: boolean) {
  requireVerification();
  const turn = core.getSnapshot().turns.at(-1)!;
  if (turn.tools.length !== 3 || turn.tools.some((tool) => tool.isError) || turn.tools[0].name !== 'process_start' || turn.tools[1].name !== 'mcp_tools' || !turn.tools[2].name.startsWith('mcp_')) throw new Error('Real Pi service/MCP admissions failed');
  const processId = String(JSON.parse(turn.tools[0].text).id);
  if (fixture.processId && fixture.processId !== processId) throw new Error('Model retry replaced the original process handle');
  fixture.processId = processId; await save(id, fixture);
  const counts = await shell('printf "%s:%s:%s" "$(cat ' + quote(fixture.directory + '/process/launches') + ')" "$(cat ' + quote(fixture.directory + '/mcp/launches') + ')" "$(cat ' + quote(fixture.directory + '/mcp/effects') + ')"');
  if (counts !== '1:1:1') throw new Error('Model retry/reopen replayed a process launch or fsynced MCP mutation: ' + counts);
  const process = await androidServices.inspect(processId), mcp = await androidServices.inspect(fixture.mcpProcessId);
  if (!resume) {
    if (process.state !== 'running' || mcp.state !== 'running') throw new Error('Retry did not preserve the running service instances');
    // Stop explicitly before the driver kills the App; reopen checks retained
    // instance identities/counters and cannot leave uncertain payloads behind.
    await core.services!.mcp.disconnect(fixture.serverId);
    for (const handle of [processId, fixture.mcpProcessId]) {
      const stopped = await androidServices.stop(handle);
      if (stopped.state !== 'exited' || stopped.processMaySurvive) throw new Error('Retry fixture cleanup could not verify process exit');
    }
  } else if ([process, mcp].some((record) => record.state !== 'exited' || record.processMaySurvive)) throw new Error('Reopening restarted a stopped service instance');
  return { processId, mcpProcessId: fixture.mcpProcessId, counters: counts, beforeExplicitStop: !resume, reopen: resume };
}
export async function cleanupRetryServices(core: Workspace, fixture: Fixture) {
  requireVerification();
  if ((await core.services!.mcp.list()).some((server) => server.id === fixture.serverId)) await core.services!.mcp.remove(fixture.serverId);
  if (!fixture.processId) {
    const tool = core.getSnapshot().turns.at(-1)?.tools.find((tool) => tool.name === 'process_start' && !tool.isError);
    if (tool) fixture.processId = String(JSON.parse(tool.text).id);
  }
  for (const id of [fixture.processId, fixture.mcpProcessId]) if (id) {
    const record = await androidServices.inspect(id).catch((error) => { if ((error as { code?: string }).code === 'ERR_MANAGED_PROCESS_NOT_FOUND') return undefined; throw error; });
    if (!record) continue;
    if (record.state !== 'exited' || record.processMaySurvive) {
      const stopped = await androidServices.stop(id);
      if (stopped.state !== 'exited' || stopped.processMaySurvive) throw new Error('Retry fixture owned stop not confirmed');
    }
    await androidServices.remove(id);
  }
}
