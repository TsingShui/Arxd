import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import type { ProcessDefinition, ProcessRecord } from '../workspace/service-types';
import type { Workspace } from '../workspace/core';
import { publishEvidence } from './evidence';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Android-only public workspace/native seam; trusted loopback fixtures, no sample execution. */
export async function verifyServiceSafety(core: Workspace, status: (text: string) => void) {
  requireVerification();
  if (!core.services) throw new Error('Native services are unavailable');
  const { processes, mcp } = core.services;
  const previousHttp = mcp.httpPolicy().allowPlaintextHttp;
  const checks: string[] = [], cleanup: string[] = [], configurations: string[] = [];
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message); };
  const shell = async (script: string) => { const value = await Rxd.runTermux(script, 10000); if (value.exitCode !== 0) throw new Error(value.stderr); return value.stdout.trim(); };
  try {
    const nativePolicy = await import('../workspace/native-services').then(({ NativeServices }) => NativeServices);
    const policyBeforeFault = JSON.stringify(mcp.httpPolicy());
    const policyFault = JSON.parse(await nativePolicy.verifyHttpPolicyCommitFailure()) as { passed: boolean; cases: { requested: boolean; rejected: boolean; gateClosed: boolean; previousPreferencePreserved: boolean }[] };
    assert(policyFault.passed && policyFault.cases.length === 2 && policyFault.cases.every((entry) => entry.rejected && entry.gateClosed && entry.previousPreferencePreserved), 'Actual Android atomic replacement failure rejects both ON and OFF without reporting saved');
    assert(JSON.stringify(mcp.httpPolicy()) === policyBeforeFault, 'The owned policy fault fixture preserves the App switch preference');
    await mcp.setHttpPolicy(true); // Explicit trusted acceptance opt-in.
    status('Preparing the managed runtime for foreground-service transition checks');
    await Rxd.prepareTermux();
    status('Checking rapid idle-to-start foreground-service transitions');
    for (let sequence = 0; sequence < 12; sequence++) {
      const brief = await processes.start(`safety-brief-${globalThis.crypto.randomUUID()}`, { name: `Trusted short transition ${sequence}`, identity: 'app', script: 'exit 19' });
      cleanup.push(brief.id);
      let previous = await processes.inspect(brief.id);
      for (let i = 0; i < 340 && !['exited', 'failed', 'lost'].includes(previous.state); i++) { await pause(50); previous = await processes.inspect(brief.id); }
      assert(previous.state === 'exited' && previous.exitCode === 19, `Short execution ${sequence} completed before the next admission`);
      const next = await processes.start(`safety-next-${globalThis.crypto.randomUUID()}`, { name: `Trusted next transition ${sequence}`, identity: 'app', script: 'while :; do sleep 1; done' });
      cleanup.push(next.id);
      let running = await processes.inspect(next.id);
      for (let i = 0; i < 340 && ['queued', 'starting'].includes(running.state); i++) { await pause(50); running = await processes.inspect(next.id); }
      assert(running.state === 'running', `Fresh execution ${sequence} survives prior service generation teardown: ${running.state} ${running.reason ?? ''}`);
      const stopped = await processes.stop(next.id);
      assert(stopped.state === 'exited' && !stopped.processMaySurvive, `Explicit stop ${sequence} completes its owned group`);
      await processes.remove(brief.id);
      cleanup.splice(cleanup.indexOf(brief.id), 1);
      await processes.remove(next.id);
      cleanup.splice(cleanup.indexOf(next.id), 1);
    }
    await verifyAdmissionBounds(core, status, assert, shell);
    status('Checking destination-scoped MCP credentials');
    const fixture = await import('../workspace/native-services').then(({ NativeServices }) => NativeServices.fixture('mcp-fixture.py'));
    const directory = await shell('mktemp -d "$TMPDIR/arxd-service-safety.XXXXXX"');
    const process = await processes.start(`safety-${globalThis.crypto.randomUUID()}`, { name: 'Trusted credential-scope fixture', identity: 'app', argv: ['python', fixture, 'http', directory] });
    cleanup.push(process.id);
    let port = '';
    for (let i = 0; i < 100 && !port; i++) { port = await shell(`test ! -f ${quote(directory + '/port')} || cat ${quote(directory + '/port')}`); if (!port) await pause(100); }
    assert(/^\d+$/.test(port), 'Loopback fixture has an observed listener');
    let config = await mcp.configure({ name: 'Credential scope', transport: 'http', enabled: true, processId: process.id, url: `http://127.0.0.1:${port}/json` });
    configurations.push(config.id);
    await mcp.credentials(config.id, { Authorization: 'Bearer fixture-token', 'X-Arxd-Fixture': 'fixture-header' });
    config = (await mcp.list()).find((item) => item.id === config.id)!;
    const credentialBeforeInvalidEdit = await processes.credentials.get(config.id);
    let invalidRejected = false;
    try { await mcp.configure({ ...config, url: 'ftp://127.0.0.1/invalid-config' }); } catch { invalidRejected = true; }
    assert(invalidRejected && await processes.credentials.get(config.id) === credentialBeforeInvalidEdit, 'Invalid configuration is rejected before changing saved credentials');
    const originalConnection = await mcp.connect(config.id);
    const before = await shell(`cat ${quote(directory + '/credential_posts')}`);
    assert(Number(before) > 0, 'Original endpoint actually received the trusted fixture credential');
    await mcp.configure({ ...config, url: `http://localhost:${port}/json` });
    const changed = (await mcp.list()).find((item) => item.id === config.id)!;
    assert(!changed.hasCredential, 'Changing destination withdraws saved credential availability');
    await mcp.connect(config.id);
    assert(await shell(`cat ${quote(directory + '/credential_posts')}`) === before, 'Replacement origin receives no previously saved credential');
    status('Rejecting a stale captured MCP connection before side-effect dispatch');
    const native = await import('../workspace/native-services').then(({ NativeServices }) => NativeServices);
    let rejected = false;
    try {
      await native.mcpRequestBound(config.id, originalConnection.connectionId!, originalConnection.toolsRevision!,
        globalThis.crypto.randomUUID(), 'tools/call', JSON.stringify({ name: 'increment', arguments: {} }), 10000);
    } catch (error) { rejected = /binding|connection|revision|changed/i.test(String(error)); }
    assert(rejected, 'Native admission rejects a captured connection replaced during JavaScript dispatch');
    assert(await shell(`test ! -f ${quote(directory + '/effects')} || cat ${quote(directory + '/effects')}`) === '', 'Stale unsafe request never executes on the replacement endpoint');
    status('Bounding discovery from an endless unique empty-page server');
    const empty = await mcp.configure({ name: 'Trusted empty-page budget fixture', transport: 'http', enabled: true,
      processId: process.id, url: `http://localhost:${port}/empty-pages` });
    configurations.push(empty.id);
    let pageLimit = false;
    try { await mcp.discover(empty.id); } catch (error) { pageLimit = /32 pages/.test(String(error)); }
    assert(pageLimit && Number(await shell(`cat ${quote(directory + '/empty_pages')}`)) === 32,
      'Unique empty discovery pages hit the declared 32-page bound without exhausting the host ledger');
    status('Checking group cleanup after a payload exits with redirected children');
    const orphanFile = directory + '/group-child';
    const short = await processes.start(`safety-group-${globalThis.crypto.randomUUID()}`, { name: 'Trusted group cleanup fixture', identity: 'app',
      script: `sleep 600 >/dev/null 2>&1 &\nprintf '%s' "$!" > ${quote(orphanFile)}\nexit 23` });
    cleanup.push(short.id);
    let finished = await processes.inspect(short.id);
    for (let i = 0; i < 120 && !['exited', 'failed', 'lost'].includes(finished.state); i++) { await pause(100); finished = await processes.inspect(short.id); }
    assert(finished.state === 'exited' && finished.exitCode === 23 && !finished.processMaySurvive, 'Payload exit code survives verified descendant-group termination');
    assert(await shell(`pid=$(cat ${quote(orphanFile)}); if test -f "/proc/$pid/stat"; then state=$(cat "/proc/$pid/stat"); case "$state" in *') Z '*) printf gone;; *) printf live;; esac; else printf gone; fi`) === 'gone', 'Redirected background child is no longer live');
    status('Checking persistence failure and interrupted Stop ownership');
    const persistence = JSON.parse(await native.verifyLaunchPersistenceFailure()) as { passed: boolean };
    assert(persistence.passed, 'Launch persistence failure is contained before spawn');
    const stubborn = await processes.start(`safety-stop-${globalThis.crypto.randomUUID()}`, { name: 'Trusted interrupted Stop fixture', identity: 'app', script: "trap '' TERM; while :; do sleep 1; done" });
    cleanup.push(stubborn.id);
    for (let i = 0; i < 120 && (await processes.inspect(stubborn.id)).state !== 'running'; i++) await pause(100);
    const interrupted = JSON.parse(await native.verifyInterruptedStop(stubborn.id)) as { passed: boolean };
    assert(interrupted.passed, 'Interrupted Stop retains native foreground ownership and admission quota');
    await processes.stop(stubborn.id);
    status('Restarting an MCP launch after explicit removal of its exited record');
    const restart = await mcp.configure({ name: 'Trusted removed-record restart', transport: 'stdio', enabled: true,
      launch: { name: 'Trusted exited fixture', identity: 'app', script: 'exit 17' } });
    configurations.push(restart.id);
    const expired = await mcp.start(restart.id, `safety-expired-${globalThis.crypto.randomUUID()}`);
    let ended = await processes.inspect(expired.id);
    for (let i = 0; i < 120 && !['exited', 'failed', 'lost'].includes(ended.state); i++) { await pause(100); ended = await processes.inspect(expired.id); }
    assert(ended.state === 'exited' && ended.exitCode === 17, 'Trusted MCP launch finishes before its record is removed');
    await processes.remove(expired.id);
    const replacement = await mcp.start(restart.id, `safety-replacement-${globalThis.crypto.randomUUID()}`);
    cleanup.push(replacement.id);
    assert(replacement.id !== expired.id, 'Explicit MCP restart accepts a genuinely removed prior execution record');
    publishEvidence(JSON.stringify({ event: 'arxd-service-safety', verified: true, checks, policyCommitFault: policyFault }));
    status(`Passed ${checks.length} service-safety checks`);
  } catch (error) {
    publishEvidence(JSON.stringify({ event: 'arxd-service-safety', verified: false, checks, error: String(error) }));
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    for (const id of configurations) { try { await mcp.remove(id); } catch (error) { cleanupFailures.push(`MCP ${id}: ${String(error).slice(0, 300)}`); } }
    for (const id of cleanup) {
      try { const record = await processes.stop(id); if (!['exited', 'failed'].includes(record.state) || record.processMaySurvive) cleanupFailures.push(`Process ${id}: cleanup unverified`); }
      catch (error) { cleanupFailures.push(`Process ${id}: ${String(error).slice(0, 300)}`); }
    }
    try { await mcp.setHttpPolicy(previousHttp); } catch (error) { cleanupFailures.push(String(error)); }
    publishEvidence(JSON.stringify({ event: 'arxd-service-safety-cleanup', verified: !cleanupFailures.length, cleanupFailures }));
  }
}


/** Named #157 limits through the same public methods used by Agent tools. */
async function verifyAdmissionBounds(core: Workspace, status: (text: string) => void,
  assert: (value: unknown, message: string) => void, shell: (script: string) => Promise<string>) {
  const { processes } = core.services!;
  const limits = processes.capabilities();
  const bound = (key: string, ceiling: number) => {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`Unsupported fixture bound ${key}`);
    return value;
  };
  const maxActive = bound('maxActive', 16), commandBytes = bound('maxCommandBytes', 65536);
  const environmentBytes = bound('maxEnvironmentBytes', 16384), writeBytes = bound('maxWriteBytes', 16384);
  const stdinMs = bound('stdinTimeoutMs', 10000), startupMs = bound('startupTimeoutMs', 30000);
  const owned = new Map<string, ProcessRecord>(), definitions = new Set<string>();
  const fixture = await import('../workspace/native-services').then(({ NativeServices }) => NativeServices.fixture('process-fixture.py'));
  const directory = await shell('mktemp -d "$TMPDIR/arxd-service-bounds.XXXXXX"');
  const token = globalThis.crypto.randomUUID();
  const exists = (path: string) => shell(`test ! -f ${quote(path)} || cat ${quote(path)}`);
  const until = async <T,>(read: () => Promise<T>, done: (value: T) => boolean, timeout = startupMs + 2000) => {
    const deadline = Date.now() + timeout;
    do { const value = await read(); if (done(value)) return value; await pause(50); } while (Date.now() < deadline);
    throw new Error('Trusted bounds fixture exceeded its finite observation window');
  };
  const start = async (name: string, request: Omit<ProcessDefinition, 'name' | 'identity'>) => {
    const record = await processes.start(`bounds-${token}-${name}`, { name: `Trusted bounds ${token} ${name}`.slice(0, 80), identity: 'app', ...request });
    owned.set(record.id, record); definitions.add(record.definitionId);
    return record;
  };
  const stopRemove = async (record: ProcessRecord) => {
    const stopped = await processes.stop(record.id);
    if (!['exited', 'failed'].includes(stopped.state) || stopped.processMaySurvive) throw new Error(`Owned fixture cleanup remains uncertain: ${record.id}`);
    await processes.remove(record.id); owned.delete(record.id);
  };
  try {
    // Refuse to consume another run's active quota or erase its uncertain record.
    let offset: number | null = 0;
    do {
      const page = await processes.list(offset, 32);
      assert(page.items.every((item) => ['exited', 'failed'].includes(item.state) && !item.processMaySurvive), 'Quota fixture starts only with no other active or uncertain records');
      offset = page.nextOffset;
    } while (offset !== null);
    status('Checking advertised active-instance admission limit before any extra spawn');
    const slots: ProcessRecord[] = [];
    for (let i = 0; i < maxActive; i++) {
      const child = `${directory}/slot-${i}`;
      const record = await start(`slot-${i}`, { argv: ['python', fixture, 'echo', child] }); slots.push(record);
      await until(() => exists(child + '/launches'), (value) => value === '1');
      await until(() => processes.inspect(record.id), (value) => value.state === 'running');
    }
    let rejected = false;
    try { await start('overflow', { argv: ['python', fixture, 'exit', directory + '/overflow'] }); } catch (error) { rejected = /active/i.test(String(error)); }
    assert(rejected && await exists(directory + '/overflow/launches') === '', 'One admission beyond advertised maxActive is rejected before its fsynced launch effect');
    assert((await Promise.all(slots.map((record) => processes.inspect(record.id)))).every((record) => record.state === 'running'), 'Rejected overload leaves every admitted instance running');
    for (const record of slots) await stopRemove(record);

    status('Checking command and environment UTF-8 byte limits before spawn');
    const before = await processes.list(), definitionsBefore = await processes.definitions();
    for (const kind of ['command', 'argv', 'environment'] as const) {
      const child = `${directory}/${kind}`;
      const prefix = `python ${quote(fixture)} exit ${quote(child)}\n#`;
      // 20 * 4000 known ASCII bytes exceed 64 KiB while each argument stays
      // inside the independently published per-argument/count/request bounds.
      const request = kind === 'command' ? { script: prefix + '界'.repeat(Math.floor(commandBytes / 3) + 1) }
        : kind === 'argv' ? { argv: ['python', fixture, 'exit', child, ...Array.from({ length: 20 }, () => 'a'.repeat(4000))] }
        : { argv: ['python', fixture, 'exit', child], environment: { ARXD_FIXTURE_VALUE: '界'.repeat(Math.floor(environmentBytes / 3) + 1) } };
      let denied = false;
      try { await start(kind, request); } catch (error) { denied = kind !== 'environment' ? /script|command|budget/i.test(String(error)) : /environment.*budget/i.test(String(error)); }
      assert(denied && await exists(child + '/launches') === '', `Oversized ${kind} UTF-8 bytes reject before a trusted child launch effect`);
    }
    assert((await processes.list()).total === before.total && (await processes.definitions()).total === definitionsBefore.total, 'Rejected byte limits leave no execution records or service definitions');

    status('Checking actual blocked stdin delivery deadline and absence of automatic retry');
    const blockedDirectory = directory + '/blocked';
    const blocked = await start('blocked', { argv: ['python', fixture, 'blocked-stdin', blockedDirectory] });
    await until(() => exists(blockedDirectory + '/launches'), (value) => value === '1');
    let failedAt = 0, accepted = 0;
    // At most 2 MiB fills the OS pipe without assuming its platform capacity.
    for (let sequence = 1; sequence <= 128; sequence++) {
      const header = `${sequence}:`, payload = header + 'x'.repeat(writeBytes - header.length - 1) + '\n';
      const started = Date.now();
      try { await processes.write(blocked.id, payload); accepted++; }
      catch (error) {
        assert(/uncertain|delivery.*failed/i.test(String(error)), 'Blocked public stdin write reports uncertain delivery and forbids automatic retry');
        assert(Date.now() - started >= stdinMs - 500 && Date.now() - started <= stdinMs + 3000, 'Actual blocked stdin fails within the advertised delivery deadline and observation allowance');
        failedAt = sequence; break;
      }
    }
    assert(failedAt === accepted + 1, 'A real nonreading child exhausts pipe capacity within the finite fixture write budget');
    await shell(`printf release > ${quote(blockedDirectory + '/release')}`);
    await until(() => exists(blockedDirectory + '/inputs'), (value) => Number(value) >= accepted, stdinMs + 2000);
    await pause(300);
    const delivered = await exists(blockedDirectory + '/delivered');
    await pause(stdinMs + 300);
    assert(await exists(blockedDirectory + '/delivered') === delivered, 'Fsynced delivered-input counter stays stable after the uncertainty deadline without an explicit retry');
    const sequences = delivered.split('\n').filter(Boolean).map(Number);
    assert(sequences.length >= accepted && sequences.length <= failedAt && new Set(sequences).size === sequences.length && sequences.every((value, index) => value === index + 1), 'Every observed input effect belongs to one explicit public write; uncertain delivery is never duplicated');
    assert(await exists(blockedDirectory + '/launches') === '1', 'Backpressure failure never restarts its process');
    await stopRemove(blocked);

    status('Checking retained loopback bind failure without claiming an existing listener');
    const listenerDirectory = directory + '/listener', conflictDirectory = directory + '/conflict';
    const listener = await start('listener', { argv: ['python', fixture, 'http', listenerDirectory] });
    const port = await until(() => exists(listenerDirectory + '/port'), (value) => /^\d+$/.test(value));
    const listenerPid = await exists(listenerDirectory + '/pid');
    const probe = () => shell(`python -c ${quote(`import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=3).read().decode())`)}`);
    assert(String(JSON.parse(await probe()).pid) === listenerPid, 'Original loopback listener responds with its independently recorded payload identity');
    const conflict = await start('conflict', { argv: ['python', fixture, 'http', conflictDirectory, '--port', port] });
    const ended = await until(() => processes.inspect(conflict.id), (value) => ['exited', 'failed', 'lost'].includes(value.state));
    assert(ended.state === 'exited' && ended.exitCode !== 0 && !ended.processMaySurvive, 'Port conflict remains a retained nonzero terminal execution without uncertain ownership');
    const error = await until(() => processes.logs(conflict.id, 'stderr', 0, Number(limits.maxLogPageBytes)), (value) => /Address already in use|Errno 98/.test(value.text ?? ''));
    assert(/Address already in use|Errno 98/.test(error.text ?? ''), 'Port-conflict diagnostic is retained in the failed instance stderr');
    await pause(300);
    assert((await processes.inspect(conflict.id)).state === ended.state && await exists(conflictDirectory + '/launches') === '1', 'Port-conflict instance is retained and never automatically restarted');
    assert((await processes.inspect(listener.id)).state === 'running' && String(JSON.parse(await probe()).pid) === listenerPid && await exists(listenerDirectory + '/launches') === '1', 'Failed bind leaves the original owned listener and launch count untouched');
    await stopRemove(conflict); await stopRemove(listener);
  } finally {
    const errors: string[] = [];
    for (const record of owned.values()) { try { await stopRemove(record); } catch (error) { errors.push(String(error)); } }
    for (const id of definitions) { try { await processes.removeDefinition(id); } catch (error) { errors.push(String(error)); } }
    if (!errors.length) await shell(`rm -r -- ${quote(directory)}`);
    publishEvidence(JSON.stringify({ event: 'arxd-service-bounds-cleanup', verified: !errors.length, cleanupFailures: errors }));
    if (errors.length) throw new Error('Owned bounds fixture cleanup failed: ' + errors.join('; '));
  }
}
