import { requireVerification } from './access';
import { publishEvidence } from './evidence';
import { requireNativeModule } from 'expo';
import Rxd from '../../modules/rxd';

type RecordValue = Record<string, unknown>;
type JsonValue = string | RecordValue;
const Native = requireNativeModule<{
  mcpHttpPolicy(): string; mcpSetHttpPolicy(allowed: boolean): Promise<string>;
  fixture(name: string): Promise<string>;
  start(admission: string, request: string): Promise<JsonValue>;
  inspect(id: string): Promise<JsonValue>;
  stop(id: string): Promise<JsonValue>;
  logs(id: string, stream: string, cursor: number, limit: number): Promise<JsonValue>;
  mcpConnect(config: string): Promise<JsonValue>;
  mcpRequest(server: string, invocation: string, method: string, params: string, timeout: number): Promise<JsonValue>;
  mcpCancel(invocation: string): void;
  mcpEnabled(server: string, value: boolean): Promise<JsonValue>;
  mcpDisconnect?(server: string): Promise<JsonValue>;
  mcpStates(): Promise<string | RecordValue[]>;
}>('ArxdServices');
const parse = (value: JsonValue): RecordValue => typeof value === 'string' ? JSON.parse(value) as RecordValue : value;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const id = () => globalThis.crypto.randomUUID();
const text = (value: RecordValue) => (value.content as { text?: string }[] | undefined)?.[0]?.text;

/** Only executes on Android: real native pipes, native HTTP, managed Python and private fixture files. */
export async function verifyNativeMcp(status: (value: string) => void, background = false, tlsUrl?: string) {
  requireVerification();
  const previousHttp = (JSON.parse(Native.mcpHttpPolicy()) as { allowPlaintextHttp: boolean }).allowPlaintextHttp;
  const checks: string[] = [];
  const processes: string[] = [];
  const servers: string[] = [];
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  async function rejects(operation: () => Promise<unknown>, pattern: RegExp, label: string) {
    let message = '';
    try { await operation(); } catch (error) { message = String(error); }
    assert(pattern.test(message), `${label}: ${message.slice(0, 120)}`);
  }
  async function shell(script: string) {
    const result = await Rxd.runTermux(script, 10000);
    assert(result.exitCode === 0, `Fixture shell completed: ${script.slice(0, 80)}`);
    return result.stdout.trim();
  }
  async function rpc(server: string, method: string, params: RecordValue = {}, timeout = 10000, invocation = id()) {
    return parse(await Native.mcpRequest(server, invocation, method, JSON.stringify(params), timeout));
  }
  async function tool(server: string, name: string, args: RecordValue = {}, timeout = 10000, invocation = id()) {
    return rpc(server, 'tools/call', { name, arguments: args }, timeout, invocation);
  }
  async function states() { const raw = await Native.mcpStates(); return typeof raw === 'string' ? JSON.parse(raw) as RecordValue[] : raw; }
  let directory = '';
  try {
    status('Preparing actual Android managed runtime');
    await Rxd.prepareTermux();
    const fixture = await Native.fixture('mcp-fixture.py');
    directory = await shell('mktemp -d "$TMPDIR/arxd-mcp-acceptance.XXXXXX"');
    async function start(transport: 'stdio' | 'http', suffix: string, server = id()) {
      const record = parse(await Native.start(`mcp-fixture-${id()}`, JSON.stringify({ name: `MCP acceptance ${suffix}`, argv: ['python', fixture, transport, `${directory}/${suffix}`], identity: 'app', ...(transport === 'stdio' ? { protocolOwner: server } : {}) })));
      const processId = String(record.id); processes.push(processId);
      return { processId, server };
    }
    async function connect(config: RecordValue) {
      servers.push(String(config.id));
      const result = parse(await Native.mcpConnect(JSON.stringify(config)));
      assert(result.state === 'connected' && result.protocolVersion === '2025-11-25', `Actual MCP initialization: ${String(config.transport)}`);
      return result;
    }
    status('Stdio initialization, pagination and UTF-8');
    const stdio = await start('stdio', 'stdio');
    const stdioConfig = { id: stdio.server, transport: 'stdio', processId: stdio.processId };
    await connect(stdioConfig);
    const page1 = await rpc(stdio.server, 'tools/list');
    assert(page1.nextCursor === 'page2', 'Server returns actual discovery cursor');
    const page2 = await rpc(stdio.server, 'tools/list', { cursor: page1.nextCursor });
    const tools = [...page1.tools as RecordValue[], ...page2.tools as RecordValue[]];
    assert(tools.length === 13 && new Set(tools.map((value) => value.name)).size === 13, 'Paginated tool names and schemas are preserved');
    assert(text(await tool(stdio.server, 'unicode')) === 'Android 原始✓ 🐉', 'Split stdio UTF-8 is reconstructed exactly');
    assert((await tool(stdio.server, 'tool_error')).isError === true, 'Tool isError remains a tool result');
    await rejects(() => tool(stdio.server, 'rpc_error'), /-32001.*Fixture RPC failure/, 'JSON-RPC error remains explicit');
    const mutation = id();
    assert(text(await tool(stdio.server, 'increment', {}, 10000, mutation)) === '1', 'Side effect executes once');
    await rejects(() => tool(stdio.server, 'increment', {}, 10000, mutation), /already admitted|replay/, 'Duplicate invocation cannot replay');
    assert(text(await tool(stdio.server, 'count')) === '1', 'Counter proves no duplicate mutation');
    await tool(stdio.server, 'unsupported'); await sleep(250);
    assert(text(await tool(stdio.server, 'unsupported_status')) === '-32601', 'Unadvertised sampling receives method-not-found');
    const revision = Number((await states()).find((value) => value.id === stdio.server)?.toolsRevision);
    await tool(stdio.server, 'notify');
    assert(Number((await states()).find((value) => value.id === stdio.server)?.toolsRevision) > revision, 'Catalog-change notification invalidates revision');
    status('Disable preserves pipes; cancellation never restarts');
    await Native.mcpEnabled(stdio.server, false);
    await rejects(() => tool(stdio.server, 'count'), /disabled|disconnected/, 'Disabled MCP rejects new admission');
    assert(parse(await Native.inspect(stdio.processId)).state === 'running', 'Disabled MCP process remains running');
    await Native.mcpEnabled(stdio.server, true);
    await connect(stdioConfig);
    assert(await shell(`cat ${quote(`${directory}/stdio/launches`)}`) === '1', 'Re-enable retains original process');
    assert(await shell(`cat ${quote(`${directory}/stdio/initializations`)}`) === '1', 'Re-enable does not initialize stdio twice');
    const slowId = id();
    const slow = tool(stdio.server, 'slow', { seconds: 10 }, 15000, slowId);
    await sleep(250); Native.mcpCancel(slowId);
    await rejects(() => slow, /cancelled|cancel/, 'Explicit native cancellation is bounded');
    await rejects(() => tool(stdio.server, 'slow', { seconds: 10 }, 150), /timed out|timeout/, 'Request timeout preserves process');
    assert(text(await tool(stdio.server, 'count')) === '1', 'Protocol remains usable after cancellation');
    const logs = parse(await Native.logs(stdio.processId, 'stderr', 0, 4096));
    assert(Number(logs.totalBytes) > 0, 'Protocol stderr remains independently retained');
    status('HTTP JSON/SSE, authentication, redirects and resumption');
    const http = await start('http', 'http');
    let port = '';
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      const probe = await Rxd.runTermux(`test ! -f ${quote(`${directory}/http/port`)} || cat ${quote(`${directory}/http/port`)}`, 5000);
      if (probe.exitCode === 0) port = probe.stdout.trim();
      if (!port) await sleep(100);
    }
    assert(/^\d+$/.test(port), 'HTTP fixture chooses an observed loopback listener');
    async function httpConnect(path: string, headers?: Record<string, string>) {
      const server = id();
      await connect({ id: server, transport: 'http', processId: http.processId, url: `http://127.0.0.1:${port}/${path}`, headers });
      return server;
    }
    if (tlsUrl) {
      if (!/^https:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp$/.test(tlsUrl)) throw new Error('TLS fixture must be an explicit HTTPS loopback endpoint');
      await rejects(() => connect({ id: id(), transport: 'http', url: tlsUrl }), /SSLHandshakeException|SSLPeerUnverifiedException|certificate|CertPath/i,
        'Platform TLS verification rejects the independent untrusted certificate before any MCP POST');
    }
    await Native.mcpSetHttpPolicy(false);
    const offPosts = await shell(`test ! -f ${quote(`${directory}/http/http_posts`)} || cat ${quote(`${directory}/http/http_posts`)}`);
    await rejects(() => httpConnect('json'), /Plain HTTP MCP is disabled/, 'OFF blocks native loopback HTTP before initialize');
    assert(await shell(`test ! -f ${quote(`${directory}/http/http_posts`)} || cat ${quote(`${directory}/http/http_posts`)}`) === offPosts, 'OFF sends zero HTTP MCP POSTs');
    assert(text(await tool(stdio.server, 'count')) === '1', 'OFF leaves the existing stdio connection usable');
    await Native.mcpSetHttpPolicy(true); // Explicit trusted acceptance opt-in.
    let json = await httpConnect('json');
    assert(text(await tool(json, 'echo', { text: 'HTTP✓' })) === 'HTTP✓', 'Streamable HTTP JSON tool result');
    const sse = await httpConnect('sse');
    assert(text(await tool(sse, 'unicode')) === 'Android 原始✓ 🐉', 'Streamable HTTP SSE BOM/CRLF/unicode result');
    await rejects(() => httpConnect('auth'), /401/, 'Unauthenticated endpoint fails explicitly');
    const oauthPosts = Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`));
    await rejects(() => httpConnect('oauth-only'), /401/, 'OAuth-only resource challenge fails explicitly without an OAuth flow');
    assert(Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`)) === oauthPosts + 1 &&
      await shell(`cat ${quote(`${directory}/http/oauth_challenges`)}`) === '1' &&
      await shell(`test ! -f ${quote(`${directory}/http/oauth_metadata`)} || cat ${quote(`${directory}/http/oauth_metadata`)}`) === '',
      'OAuth-only challenge sends one initialize POST and never follows protected-resource metadata');
    const auth = await httpConnect('auth', { Authorization: 'Bearer fixture-token', 'X-Arxd-Fixture': 'fixture-header' });
    assert(text(await tool(auth, 'count')) === '0', 'Token and custom headers reach only configured endpoint');
    let authError = '';
    try { await tool(auth, 'rpc_error'); } catch (error) { authError = String(error); }
    assert(authError.includes('-32001') && !authError.includes('fixture-token') && !authError.includes('fixture-header'), 'Server RPC errors redact configured credential values');
    const beforePosts = Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`));
    await rejects(() => httpConnect('redirect', { Authorization: 'Bearer fixture-token' }), /302/, 'HTTP redirect rejected');
    const afterPosts = Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`));
    assert(afterPosts - beforePosts === 1, 'Redirect does not forward headers or repeat POST');
    const pendingOff = tool(json, 'slow', { seconds: 10 }, 15000);
    void pendingOff.catch(() => undefined);
    let accepted = false;
    for (let i = 0; i < 60 && !accepted; i++) {
      const raw = await shell(`test ! -f ${quote(`${directory}/http/slow-markers.json`)} || cat ${quote(`${directory}/http/slow-markers.json`)}`);
      accepted = !!raw && (JSON.parse(raw) as { entries: { phase: string }[] }).entries.some((entry) => entry.phase === 'started');
      if (!accepted) await sleep(50);
    }
    assert(accepted, 'Independent HTTP fixture accepted the in-flight request before OFF');
    await Native.mcpSetHttpPolicy(false);
    await rejects(() => pendingOff, /disconnected|disabled|unknown|uncertain/i, 'OFF cancels the in-flight HTTP request with an explicit uncertain outcome');
    const postsAtOff = await shell(`cat ${quote(`${directory}/http/http_posts`)}`);
    await rejects(() => tool(json, 'increment'), /Plain HTTP MCP is disabled/, 'OFF blocks a cached admitted native HTTP tool');
    assert(await shell(`cat ${quote(`${directory}/http/http_posts`)}`) === postsAtOff && parse(await Native.inspect(http.processId)).state === 'running', 'OFF adds no POST and preserves the HTTP server process');
    assert(text(await tool(stdio.server, 'count')) === '1', 'OFF preserves stdio during HTTP cancellation');
    await Native.mcpSetHttpPolicy(true);
    await rejects(() => tool(json, 'count'), /disabled|disconnected/, 'ON does not automatically reconnect old native tool bindings');
    json = await httpConnect('json');
    await rejects(() => httpConnect('version'), /Unsupported MCP protocol version/, 'Unsupported negotiation rejected');
    const resume = await httpConnect('resume');
    assert(text(await tool(resume, 'increment')) === '1', 'SSE GET cursor resumes original mutation result');
    assert(text(await tool(json, 'count')) === '1', 'HTTP counter proves POST was not replayed');
    const uncertain = await httpConnect('uncertain');
    const beforeUncertain = Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`));
    await rejects(() => tool(uncertain, 'increment'), /uncertain|transport failed/, 'Connection loss retains uncertain execution');
    const afterUncertain = Number(await shell(`cat ${quote(`${directory}/http/http_posts`)}`));
    assert(afterUncertain - beforeUncertain === 1 && text(await tool(json, 'count')) === '2', 'Connection loss never retries side-effecting POST');
    const expired = await httpConnect('expired');
    await rejects(() => tool(expired, 'count'), /404/, 'Expired session does not replay original request');
    assert(!JSON.stringify(await states()).includes('fixture-token') && !JSON.stringify(await states()).includes('fixture-header'), 'Native public states do not retain credential values');
    if (background) {
      type Markers = { version: number; pid: number; entries: { rpcId: string; phase: string; startedEpochMs: number; finishedEpochMs?: number; outcome?: string }[] };
      const markerFile = quote(`${directory}/stdio/slow-markers.json`);
      const before = JSON.parse(await shell(`cat ${markerFile}`)) as Markers;
      const previous = new Set(before.entries.map((entry) => entry.rpcId));
      const app = await Rxd.getInfo();
      const stdioBefore = parse(await Native.inspect(stdio.processId));
      const httpBefore = parse(await Native.inspect(http.processId));
      const invocation = id(), initiatedAt = Date.now();
      const pending = tool(stdio.server, 'slow', { seconds: 10 }, 25000, invocation);
      void pending.catch(() => undefined); // Keep a bounded native failure handled during the synchronous JS hold.
      let marker: Markers['entries'][number] | undefined;
      for (let attempt = 0; attempt < 30 && !marker; attempt++) {
        const current = JSON.parse(await shell(`cat ${markerFile}`)) as Markers;
        marker = current.entries.find((entry) => !previous.has(entry.rpcId) && entry.phase === 'started' && entry.startedEpochMs >= initiatedAt);
        if (!marker) await sleep(50);
      }
      assert(marker, 'The independent stdio fixture records the actual slow request before backgrounding');
      const jsHoldStartedEpochMs = Date.now(), holdStarted = performance.now(), jsHoldMs = 14000;
      publishEvidence(JSON.stringify({ event: 'arxd-mcp-native-ready-background', verified: true, processId: stdio.processId,
        httpProcessId: http.processId, port, directory, appPid: app.processId, rpcId: marker!.rpcId, invocation,
        stdioPayloadPid: stdioBefore.payloadPid, httpPayloadPid: httpBefore.payloadPid, jsHoldStartedEpochMs, jsHoldMs,
        mode: 'real-native-rpc/bounded-trusted-synchronous-js-hold' }));
      // This deliberately makes the JS thread unavailable while native pipes,
      // request correlation and the fixture keep running. It is verification
      // code only, bounded to 14 seconds; it does not claim Android paused JS.
      while (performance.now() - holdStarted < jsHoldMs) { /* trusted acceptance hold */ }
      const jsHoldFinishedEpochMs = Date.now(), actualJsHoldMs = performance.now() - holdStarted;
      assert(text(await pending) === 'slow-finished', 'The same native stdio response survives the JS hold/background interval');
      const written = (JSON.parse(await shell(`cat ${markerFile}`)) as Markers).entries.find((entry) => entry.rpcId === marker!.rpcId);
      assert(written?.phase === 'response-written' && written.outcome === 'success' && written.finishedEpochMs! >= jsHoldStartedEpochMs && written.finishedEpochMs! <= jsHoldFinishedEpochMs,
        'The independent server flushed the correlated response while JavaScript was unavailable');
      // Keep both real servers available for the host's locked HTTP probes and
      // same-Activity return. No second initialize or launch is performed.
      await sleep(Math.max(0, jsHoldStartedEpochMs + 30000 - Date.now()));
      const stdioAfter = parse(await Native.inspect(stdio.processId)), httpAfter = parse(await Native.inspect(http.processId));
      assert(stdioAfter.state === 'running' && httpAfter.state === 'running' && stdioAfter.payloadPid === stdioBefore.payloadPid && httpAfter.payloadPid === httpBefore.payloadPid,
        'Stdio and HTTP retain their actual payload identities across the locked interval');
      publishEvidence(JSON.stringify({ event: 'arxd-mcp-native-background-finished', verified: true, processId: stdio.processId,
        httpProcessId: http.processId, appPid: (await Rxd.getInfo()).processId, rpcId: marker!.rpcId, invocation,
        stdioPayloadPid: stdioAfter.payloadPid, httpPayloadPid: httpAfter.payloadPid,
        jsHoldStartedEpochMs, jsHoldFinishedEpochMs, actualJsHoldMs, marker: written }));
    }
    status('Oversized/malformed protocol and process exit');
    await rejects(() => tool(stdio.server, 'oversized'), /oversized|budget|Malformed/, 'Oversized stdio result is bounded');
    assert((await states()).find((value) => value.id === stdio.server)?.state === 'failed', 'Oversized protocol visibly invalidates connection');
    await Native.stop(stdio.processId);
    await rejects(() => tool(stdio.server, 'count'), /disconnected|disabled|unavailable/, 'Exited process does not restart on tool use');
    const malformed = await start('stdio', 'malformed');
    await connect({ id: malformed.server, transport: 'stdio', processId: malformed.processId });
    await rejects(() => tool(malformed.server, 'malformed'), /Malformed|malformed/, 'Malformed protocol fails without hanging');
    const deep = await start('stdio', 'deep');
    await connect({ id: deep.server, transport: 'stdio', processId: deep.processId });
    await rejects(() => tool(deep.server, 'deep'), /Malformed|malformed/, 'Deep JSON rejected before recursive parser');
    publishEvidence(JSON.stringify({ event: 'arxd-mcp-native', verified: true, tlsTrustTested: !!tlsUrl, checks, processIds: processes, serverIds: servers, directory, mode: 'real-android-managed-python-native-stdio-http' }));
    status(`Passed ${checks.length} Android native MCP checks`);
    return checks;
  } catch (error) {
    publishEvidence(JSON.stringify({ event: 'arxd-mcp-native', verified: false, checks, error: String(error), processIds: processes, directory }));
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    const loaded = await states().catch(() => []);
    for (const server of servers) {
      if (!loaded.some((state) => state.id === server)) continue;
      try {
        if (Native.mcpDisconnect) await Native.mcpDisconnect(server);
        else await Native.mcpEnabled(server, false);
      } catch (error) { cleanupFailures.push(`Disconnect ${server}: ${String(error).slice(0, 500)}`); }
    }
    for (const process of processes) {
      try {
        const stopped = parse(await Native.stop(process));
        if (!['exited', 'failed'].includes(String(stopped.state)) || stopped.processMaySurvive) cleanupFailures.push(`Process cleanup unverified: ${process}`);
      } catch (error) { cleanupFailures.push(`Stop ${process}: ${String(error).slice(0, 500)}`); }
    }
    try { await Native.mcpSetHttpPolicy(previousHttp); } catch (error) { cleanupFailures.push(String(error)); }
    publishEvidence(JSON.stringify({ event: 'arxd-mcp-native-cleanup', verified: !cleanupFailures.length, cleanupFailures, processIds: processes }));
  }
}
