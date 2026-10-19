import type { TSchema } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { defineExtension, defineTool, type Registry, type Extension } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { McpCatalogItem, McpConfigStore, McpDefinition, McpExposure, McpOAuthSettings, McpState, McpTool, ServiceHost } from './service-types.ts';

export const MCP_DISCOVERY_LIMITS = { maxPages: 32, timeoutMs: 60000 } as const;
function discoveryAwait<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal, cancel?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (run: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); run(); };
    const aborted = () => finish(() => { try { cancel?.(); } catch { /* The caller still receives its bounded outcome. */ } reject(new Error('MCP discovery canceled; no further pages or tool calls are dispatched')); });
    timer = setTimeout(() => finish(() => { try { cancel?.(); } catch { /* The caller still receives its bounded outcome. */ } reject(new Error('MCP discovery total deadline exceeded')); }), Math.max(0, deadline - performance.now()));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

const idPattern = /^[a-f0-9-]{36}$/;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP returned a non-object result'); return value as Record<string, unknown>; }
function safeReason(error: unknown) { return String(error).replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1000); }
function uuidFor(name: string): string {
  const part = (salt: number) => { let value = 2166136261 ^ salt; for (let i = 0; i < name.length; i++) value = Math.imul(value ^ name.charCodeAt(i), 16777619); return (value >>> 0).toString(16).padStart(8, '0'); };
  const hex = part(0) + part(1) + part(2) + part(3);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const exposureOf = (config: McpDefinition, tool: string): McpExposure => config.toolExposure?.[tool] ?? config.exposure ?? 'codemode';
function piNamespace(name: string) { return `mcp__${name.replace(/-/g, '_')}`; }
function toolName(server: string, remote: string): string { return `${piNamespace(server)}__${remote.replace(/[^A-Za-z0-9_]/g, '_')}`; }
type PiServer = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; enabled?: boolean; exposure?: McpExposure; toolExposure?: Record<string, McpExposure>; description?: string; timeout?: number; oauth?: McpOAuthSettings; auth?: unknown };
function fromPi(name: string, raw: PiServer): McpDefinition {
  const transport: 'stdio' | 'http' = typeof raw.url === 'string' ? 'http' : 'stdio';
  if (transport === 'stdio' && (typeof raw.command !== 'string' || !raw.command)) throw new Error(`MCP server "${name}" needs command or url`);
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string'))) throw new Error(`MCP server "${name}" has invalid args`);
  if (raw.url !== undefined && (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url))) throw new Error(`MCP server "${name}" has invalid url`);
  const launch = transport === 'stdio' ? { name, argv: [raw.command!, ...(raw.args ?? [])], identity: 'app' as const, ...(raw.cwd && raw.cwd.startsWith('/') ? { cwd: raw.cwd } : {}), ...(raw.env ? { environment: raw.env } : {}) } : undefined;
  return { id: uuidFor(name), name, transport, enabled: raw.enabled !== false, revision: 1, exposure: raw.exposure ?? 'codemode',
    ...(raw.toolExposure ? { toolExposure: raw.toolExposure } : {}), ...(raw.description ? { description: raw.description } : {}), ...(raw.timeout ? { timeout: raw.timeout } : {}),
    ...(raw.url ? { url: raw.url } : {}), ...(raw.headers ? { headers: raw.headers } : {}), ...(raw.oauth ? { oauth: raw.oauth } : {}), ...(raw.env ? { env: raw.env } : {}), ...(raw.command ? { command: raw.command, args: raw.args ?? [] } : {}),
    ...(raw.cwd ? { cwd: raw.cwd } : {}), ...(launch ? { launch } : {}), hasCredential: !!raw.headers && Object.keys(raw.headers).length > 0 };
}
function toPi(config: McpDefinition): PiServer {
  return { ...(config.transport === 'http' ? { url: config.url } : { command: config.command ?? config.launch?.argv?.[0], args: config.args ?? config.launch?.argv?.slice(1), cwd: config.cwd ?? config.launch?.cwd, env: config.env ?? config.launch?.environment, headers: config.headers }),
    enabled: config.enabled, exposure: config.exposure ?? 'codemode', ...(config.toolExposure ? { toolExposure: config.toolExposure } : {}), ...(config.description ? { description: config.description } : {}), ...(config.timeout ? { timeout: config.timeout } : {}), ...(config.oauth ? { oauth: config.oauth } : {}) };
}

/** Configuration belongs to the workspace; native transports and processes own their live lifetimes. */
export class McpLibrary {
  private readonly configurations = new Map<string, McpDefinition>();
  private readonly catalog = new Map<string, { tools: McpTool[]; revision: number; connectionId: string; configRevision: number; binding: string; token: string; aliases: Map<string, string>; extension: Extension }>();
  private readonly errors = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private workspaceScope?: string;
  get scope() { if (!this.workspaceScope) throw new Error('Service workspace has not opened'); return this.workspaceScope; }
  private readonly listeners = new Set<() => void>();
  private configSha = '';
  constructor(private readonly db: SqliteDatabase, readonly host: ServiceHost, private readonly registry: Registry, private readonly store?: McpConfigStore) {}
  async open() {
    await this.db.exec('CREATE TABLE IF NOT EXISTS arxd_mcp_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    const version = await this.db.get<{ value: string }>('SELECT value FROM arxd_mcp_meta WHERE key=?', 'schema');
    if (version && version.value !== '1') throw new Error('Unsupported MCP workspace schema');
    await this.db.run('INSERT OR IGNORE INTO arxd_mcp_meta (key,value) VALUES (?,?)', 'schema', '1');
    await this.db.run('INSERT OR IGNORE INTO arxd_mcp_meta (key,value) VALUES (?,?)', 'workspace-scope', globalThis.crypto.randomUUID());
    const scope = await this.db.get<{ value: string }>('SELECT value FROM arxd_mcp_meta WHERE key=?', 'workspace-scope');
    if (!scope || !idPattern.test(scope.value)) throw new Error('Invalid service workspace identity');
    this.workspaceScope = scope.value;
    if (this.store) {
      const file = await this.store.read();
      let entries: Record<string, PiServer> | undefined;
      if (file?.text) {
        const parsed: unknown = JSON.parse(file.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Pi mcp.json must contain an object');
        const raw = (parsed as { mcpServers?: unknown }).mcpServers;
        if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Pi mcp.json mcpServers must be an object');
        entries = (raw ?? {}) as Record<string, PiServer>;
        this.configSha = file.sha256;
      } else {
        // One-time export from the old workspace table; after this the Pi file
        // is the only configuration source.
        try {
          const rows = await this.db.all<{ id: string; value: string }>('SELECT id,value FROM arxd_mcp ORDER BY id LIMIT 65');
          entries = Object.fromEntries(rows.map((row) => { const old = JSON.parse(row.value) as McpDefinition; return [old.name, toPi(old)]; }));
          if (rows.length) {
            const text = JSON.stringify({ mcpServers: entries }, null, 2) + '\n';
            this.configSha = (await this.store.write(text, '')).sha256;
          }
        } catch {
          entries = {};
        }
        await this.db.run('DROP TABLE IF EXISTS arxd_mcp');
      }
      const names = Object.keys(entries ?? {});
      if (names.length > 64) throw new Error('MCP configuration limit is 64');
      for (const name of names) { const config = fromPi(name, entries![name]); this.configurations.set(config.id, config); }
      await this.db.exec('DROP TABLE IF EXISTS arxd_mcp');
      return;
    }
    const rows = await this.db.all<{ id: string; value: string }>('SELECT id,value FROM arxd_mcp ORDER BY id LIMIT 65');
    if (rows.length > 64) throw new Error('MCP configuration limit exceeded');
    for (const row of rows) { const config = JSON.parse(row.value) as McpDefinition; this.validate(config); this.configurations.set(row.id, config); }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private queue<T>(run: () => Promise<T>) { const next = this.tail.then(run); this.tail = next.catch(() => undefined); return next; }
  private validate(config: McpDefinition) {
    if (!idPattern.test(config.id) || !config.name.trim() || config.name.length > 80 || !['stdio', 'http'].includes(config.transport) || !Number.isSafeInteger(config.revision) || config.revision < 1 || bytes(config) > 98304) throw new Error('Invalid MCP configuration');
    if (config.transport === 'http') {
      const url = new URL(config.url ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || config.url!.length > 4096) throw new Error('Use an explicit HTTP/HTTPS MCP endpoint without embedded credentials');
    } else if (!config.launch && !config.definitionId && !config.processId) throw new Error('A stdio MCP needs a launch definition or owned process');
    if (config.definitionId && (!/^svc-v1-[a-f0-9]{64}$/.test(config.definitionId) || config.launch)) throw new Error('Use one saved service definition reference or inline launch configuration');
    if (config.processId && !idPattern.test(config.processId)) throw new Error('Invalid linked process');
    if (config.launch && (bytes(config.launch) > 81920 || !['app', 'root'].includes(config.launch.identity))) throw new Error('Invalid MCP launch definition');
  }
  private get(id: string) { const value = this.configurations.get(id); if (!value) throw new Error('Unknown MCP server'); return value; }
  private async save(config: McpDefinition) {
    this.validate(config);
    this.configurations.set(config.id, config);
    if (this.store) {
      const servers: Record<string, PiServer> = {};
      for (const current of this.configurations.values()) servers[current.name] = toPi(current);
      const text = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
      this.configSha = (await this.store.write(text, this.configSha)).sha256;
    } else await this.db.run('INSERT OR REPLACE INTO arxd_mcp(id,value) VALUES (?,?)', config.id, JSON.stringify(config));
    this.changed(); return { ...config };
  }
  httpPolicy() { return this.host.mcpHttpPolicy(); }
  /** UI only: deliberately absent from the Agent tool extension. */
  async setHttpPolicy(allowed: boolean) {
    if (!allowed) for (const config of this.configurations.values()) if (this.plainHttp(config)) this.clearTools(config.id);
    this.changed();
    try { return await this.host.mcpSetHttpPolicy(allowed); } finally {
      // Discovery may have awaited native publication during the toggle.
      if (!this.httpPolicy().allowPlaintextHttp) for (const config of this.configurations.values()) if (this.plainHttp(config)) this.clearTools(config.id);
      this.changed();
    }
  }
  private plainHttp(config: McpDefinition) { return config.transport === 'http' && new URL(config.url!).protocol === 'http:'; }
  private requireHttpPolicy(config: McpDefinition) {
    if (this.plainHttp(config) && !this.httpPolicy().allowPlaintextHttp) {
      this.clearTools(config.id);
      throw new Error('Plain HTTP MCP is disabled; enable it explicitly in Settings. HTTPS and stdio are unaffected');
    }
  }
  async reload() {
    if (!this.store) return;
    const file = await this.store.read();
    if (!file?.text) return;
    const parsed: unknown = JSON.parse(file.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Pi mcp.json must contain an object');
    const raw = (parsed as { mcpServers?: unknown }).mcpServers;
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Pi mcp.json mcpServers must be an object');
    if (file.sha256 === this.configSha) return;
    const old = new Map([...this.configurations.values()].map((config) => [config.name, config]));
    const next = new Map<string, McpDefinition>();
    for (const [name, value] of Object.entries((raw ?? {}) as Record<string, PiServer>)) {
      const config = fromPi(name, value);
      const previous = old.get(name);
      if (previous) { config.revision = previous.revision + 1; config.processId = previous.processId; config.serviceDefinitionId = previous.serviceDefinitionId; config.hasCredential = previous.hasCredential; config.credentialRevision = previous.credentialRevision; }
      next.set(config.id, config);
      old.delete(name);
    }
    for (const removed of old.values()) this.clearTools(removed.id);
    this.configurations.clear(); for (const [id, config] of next) this.configurations.set(id, config);
    this.configSha = file.sha256; this.changed();
  }
  async startup() {
    for (const config of [...this.configurations.values()]) {
      if (!config.enabled) continue;
      try { await this.discover(config.id); } catch (error) { this.errors.set(config.id, safeReason(error)); this.changed(); }
    }
  }
  async list(): Promise<McpCatalogItem[]> {
    await this.reload().catch(() => undefined);
    const states = await this.host.mcpStates();
    return [...this.configurations.values()].map((config) => ({ ...config, policyBlocked: this.plainHttp(config) && !this.httpPolicy().allowPlaintextHttp, connection: states.find((state) => state.id === config.id), toolCount: this.catalog.get(config.id)?.tools.length, error: this.errors.get(config.id) }));
  }
  configure(input: Omit<McpDefinition, 'id' | 'revision' | 'hasCredential' | 'credentialRevision'> & { id?: string }) {
    return this.queue(async () => {
      if (!input.id && this.configurations.size >= 64) throw new Error('MCP configuration limit is 64');
      const old = input.id ? this.get(input.id) : undefined;
      const destinationChanged = !!old && old.transport === 'http' &&
        (input.transport !== 'http' || new URL(old.url!).href !== new URL(input.url ?? '').href);
      const config: McpDefinition = { ...input, id: old?.id ?? uuidFor(input.name), revision: (old?.revision ?? 0) + 1,
        hasCredential: destinationChanged ? false : old?.hasCredential ?? false,
        credentialRevision: (old?.credentialRevision ?? 0) + (destinationChanged ? 1 : 0) };
      this.validate(config);
      if (old) await this.host.mcpEnabled(old.id, false).catch(() => undefined);
      if (destinationChanged) await this.host.credentials.remove(old!.id);
      this.clearTools(config.id); this.errors.delete(config.id);
      return this.save(config);
    });
  }
  enabled(id: string, enabled: boolean) { return this.queue(async () => {
    const config = this.get(id);
    const saved = await this.save({ ...config, enabled, revision: config.revision + 1 });
    this.clearTools(id);
    const native = (await this.host.mcpStates()).find((state) => state.id === id);
    if (native) await this.host.mcpEnabled(id, enabled);
    return saved;
  }); }
  credentials(id: string, headers: Record<string, string> | null) { return this.queue(async () => {
    const config = this.get(id);
    if (config.transport !== 'http') throw new Error('HTTP credentials are separate from root execution identity');
    if (headers) {
      if (Object.keys(headers).length > 32 || bytes(headers) > 8192 || Object.entries(headers).some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value))) throw new Error('Invalid MCP credential headers');
      await this.host.credentials.set(id, JSON.stringify(headers));
    } else await this.host.credentials.remove(id);
    await this.host.mcpDisconnect(id).catch(() => undefined); this.clearTools(id);
    return this.save({ ...config, hasCredential: !!headers, credentialRevision: (config.credentialRevision ?? 0) + 1, revision: config.revision + 1 });
  }); }
  start(id: string, admission: string) { return this.queue(async () => {
    const config = this.get(id);
    if (!config.launch && !config.definitionId) throw new Error('This MCP has no local launch definition');
    if (config.processId) {
      try {
        const old = await this.host.inspect(config.processId);
        if (['queued', 'starting', 'running', 'stopping'].includes(old.state)) return old;
        if (old.processMaySurvive) throw new Error('Previous process ownership is uncertain; verify cleanup before starting a replacement');
      } catch (error) {
        if ((error as { code?: string })?.code !== 'ERR_MANAGED_PROCESS_NOT_FOUND') throw error;
        // An explicitly removed exited record expires the association. Only this
        // structured native outcome permits a new explicit launch; I/O errors do not.
      }
    }
    const instance = await this.host.start(admission, { ...(config.launch ?? { definitionId: config.definitionId! }), protocolOwner: config.transport === 'stdio' ? id : undefined, origin: 'mcp:' + id });
    await this.save({ ...config, processId: instance.id, serviceDefinitionId: instance.definitionId, revision: config.revision + 1 });
    return instance;
  }); }
  private clearTools(id: string) { const old = this.catalog.get(id); if (old) this.registry.uninstall(old.extension); this.catalog.delete(id); }
  signIn(id: string) { return this.queue(async () => {
    const config = this.get(id);
    if (config.transport !== 'http' || !config.url) throw new Error('OAuth is only available for HTTP MCP servers');
    if (!this.store?.oauthSignIn) throw new Error('OAuth host is unavailable');
    await this.store.oauthSignIn(config.name, config.url, config.oauth ?? {});
    this.errors.delete(id); this.clearTools(id); this.changed();
    return this.discover(id);
  }); }
  signOut(id: string) { return this.queue(async () => {
    const config = this.get(id);
    if (config.transport !== 'http' || !config.url) throw new Error('OAuth is only available for HTTP MCP servers');
    await this.store?.oauthSignOut?.(config.name, config.url);
    this.clearTools(id); this.errors.delete(id); this.changed();
  }); }
  async connect(id: string): Promise<McpState> {
    let config = this.get(id);
    this.requireHttpPolicy(config);
    if (!config.enabled) throw new Error('MCP server is disabled');
    if (config.processId) {
      const process = await this.host.inspect(config.processId);
      if (!['queued', 'starting', 'running'].includes(process.state)) throw new Error(`Linked process is ${process.state}: ${safeReason(process.reason ?? process.ioError ?? 'no further diagnostic')}; start is an explicit action`);
    }
    if (config.transport === 'stdio' && !config.processId) { await this.start(id, `pi-mcp/${this.scope}/connect`); config = this.get(id); }
    const encoded = config.hasCredential && this.store ? undefined : config.hasCredential ? await this.host.credentials.get(id) : undefined;
    if (config.hasCredential && !encoded && !config.headers) throw new Error('MCP credentials are unavailable');
    try {
      let headers = encoded ? JSON.parse(encoded) as Record<string, string> : config.headers;
      if (!headers && config.transport === 'http' && config.url && this.store?.oauthToken) {
        try {
          const token = await this.store.oauthToken(config.name, config.url, config.oauth ?? {});
          if (token) headers = { Authorization: `Bearer ${token}` };
        } catch { /* A missing/expired token falls through to the server's 401. */ }
      }
      if (!headers && config.transport === 'http' && config.url && this.store?.readAuth) {
        try {
          const auth = JSON.parse(await this.store.readAuth() ?? '{}') as Record<string, { tokens?: { access_token?: string } }>;
          const token = auth[`${piNamespace(config.name)}|${new URL(config.url).href}`]?.tokens?.access_token;
          if (token) headers = { Authorization: `Bearer ${token}` };
        } catch { /* An unreadable Pi auth file is not a credential. */ }
      }
      const state = await this.host.mcpConnect({ id, transport: config.transport, processId: this.get(id).processId, url: config.url,
        ...(headers ? { headers } : {}) });
      this.errors.delete(id); this.changed(); return state;
    } catch (error) { this.errors.set(id, safeReason(error)); this.changed(); throw error; }
  }
  async discover(id: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('MCP discovery canceled before dispatch');
    const deadline = performance.now() + MCP_DISCOVERY_LIMITS.timeoutMs;
    const config = this.get(id);
    let revision = config.revision;
    // Initialization already in flight may settle, but canceling this discovery
    // must not disconnect the shared transport or cancel another Agent's calls.
    const connection = await discoveryAwait(this.connect(id), deadline, signal);
    revision = this.get(id).revision;
    if (!connection.connectionId || !Number.isSafeInteger(connection.toolsRevision)) throw new Error('MCP connection lacks a verifiable binding');
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined, pages = 0;
    do {
      if (++pages > MCP_DISCOVERY_LIMITS.maxPages) throw new Error('MCP discovery exceeds 32 pages');
      if (signal?.aborted) throw new Error('MCP discovery canceled before the next page');
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 100) throw new Error('MCP discovery total deadline exceeded');
      if (this.get(id).revision !== revision || !this.get(id).enabled) throw new Error('MCP configuration changed during discovery');
      const invocation = globalThis.crypto.randomUUID();
      const page = object(await discoveryAwait(this.host.mcpRequestBound(id, connection.connectionId!, connection.toolsRevision!, invocation, 'tools/list', cursor ? { cursor } : {}, Math.min(30000, remaining)), deadline, signal, () => this.host.mcpCancel(invocation)));
      if (!Array.isArray(page.tools)) throw new Error('MCP tools/list did not return tools');
      for (const value of page.tools) {
        const raw = object(value);
        if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 128 || typeof raw.description !== 'undefined' && typeof raw.description !== 'string') throw new Error('MCP tool metadata is invalid');
        const schema = object(raw.inputSchema);
        if (schema.type !== 'object' || bytes(schema) > 131072 || tools.some((tool) => tool.name === raw.name)) throw new Error('MCP tool schemas are invalid, duplicated or oversized');
        tools.push({ name: raw.name, description: typeof raw.description === 'string' ? raw.description.slice(0, 8192) : undefined, inputSchema: schema, ...(raw.outputSchema ? { outputSchema: object(raw.outputSchema) } : {}) });
        if (tools.length > 256 || bytes(tools) > 1048576) throw new Error('MCP catalog exceeds 256 tools or 1 MiB');
      }
      if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') throw new Error('MCP discovery cursor is invalid');
      cursor = page.nextCursor as string | undefined;
      if (cursor !== undefined) { if (cursor.length > 4096 || cursors.has(cursor)) throw new Error('MCP discovery cursor did not advance'); cursors.add(cursor); }
    } while (cursor !== undefined);
    if (this.get(id).revision !== revision || !this.get(id).enabled) throw new Error('MCP configuration changed during discovery');
    const discovered = (await discoveryAwait(this.host.mcpStates(), deadline, signal)).find((state) => state.id === id);
    if (!discovered?.enabled || discovered.state !== 'connected' || discovered.connectionId !== connection.connectionId || discovered.toolsRevision !== connection.toolsRevision) {
      throw new Error('MCP connection or schemas changed during discovery; retry discovery explicitly');
    }
    // Pi persists offered tool names across model/tool phases. A replacement
    // extension must never reuse an alias for a different captured contract,
    // even when the server silently changes schema without list_changed.
    const binding = canonical({ version: 1, id, configRevision: revision, connectionId: connection.connectionId,
      toolsRevision: connection.toolsRevision, tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)) });
    const previous = this.catalog.get(id);
    const token = previous?.binding === binding ? previous.token : globalThis.crypto.randomUUID().replaceAll('-', '');
    // Publish under the native admission lock before installing new closures.
    // Old calls racing this async refresh fail atomically even if connection and
    // native notification revision did not change with the actual schema.
    await discoveryAwait(this.host.mcpPublishCatalog(id, connection.connectionId!, connection.toolsRevision!, token), deadline, signal);
    if (this.get(id).revision !== revision || !this.get(id).enabled) throw new Error('MCP configuration changed during catalog publication');
    const aliases = new Map<string, string>();
    const names = new Set<string>();
    const registrations = tools.map((remote) => {
      const name = toolName(config.name, remote.name);
      if (names.has(name)) throw new Error('MCP tool identity collision'); names.add(name); aliases.set(remote.name, name);
      const exposure = exposureOf(config, remote.name);
      return defineTool({ name, description: `[${config.name} / ${remote.name}] ${remote.description ?? ''}`.slice(0, 8192),
        parameters: remote.inputSchema as TSchema, replay: 'unsafe', executionMode: 'parallel',
        ...(exposure === 'hidden' ? { callers: [] as const } : exposure === 'codemode' ? { callers: ['tools'] as const } : {}),
        ...(exposure === 'deferred' ? { deferred: true as const } : {}),
        outputLimits: { maxBytes: 196608, maxLines: 2048, retain: 'head' },
        execute: async (arguments_: Record<string, unknown>, api, context) => {
          const current = this.get(id);
          this.requireHttpPolicy(current);
          if (this.catalog.get(id)?.binding !== binding) throw new Error('Offered MCP catalog was replaced; explicitly rediscover before calling');
          if (!current.enabled || current.revision !== revision) throw new Error('MCP access or configuration changed; rediscover tools');
          const native = (await this.host.mcpStates()).find((state) => state.id === id);
          if (!native?.enabled || native.state !== 'connected' || native.connectionId !== connection.connectionId || native.toolsRevision !== connection.toolsRevision) {
            throw new Error('MCP connection or schemas changed; rediscover tools before calling');
          }
          if (bytes(arguments_) > 196608) throw new Error('MCP arguments exceed output/input budget');
          const invocation = `mcp/${this.scope}/${id}/${api.conversationId}/${api.taskId}`;
          const cancel = () => this.host.mcpCancel(invocation);
          if (context.abortSignal?.aborted) throw new Error('MCP call canceled before dispatch');
          context.abortSignal?.addEventListener('abort', cancel, { once: true });
          try {
            const result = object(await this.host.mcpRequestBound(id, connection.connectionId!, connection.toolsRevision!, invocation, 'tools/call', { name: remote.name, arguments: arguments_ }, 30000, token));
            let invalid: string | undefined;
            if (!Array.isArray(result.content) || result.isError !== undefined && typeof result.isError !== 'boolean') invalid = 'MCP tool returned invalid content or error metadata';
            if (remote.outputSchema && !result.isError) {
              try {
                if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) throw new Error('Missing structured content');
                const checked = validateToolArguments({ name: remote.name, description: '', parameters: remote.outputSchema as TSchema },
                  { type: 'toolCall', id: invocation, name: remote.name, arguments: result.structuredContent as Parameters<typeof validateToolArguments>[1]['arguments'] });
                if (JSON.stringify(checked) !== JSON.stringify(result.structuredContent)) throw new Error('Output would require coercion');
              } catch { invalid = 'MCP structured output does not conform to its discovered schema'; }
            }
            const text = JSON.stringify(result), complete = new TextEncoder().encode(text).length <= 131072;
            return { isError: !!result.isError || !complete || !!invalid, output: [{ type: 'text' as const, text: JSON.stringify({ serverId: id, tool: remote.name, configRevision: revision, complete, ...(invalid ? { validationError: invalid } : {}),
              ...(complete ? { result } : { remoteCallCompleted: true, resultBytes: new TextEncoder().encode(text).length, preview: text.slice(0, 32768) }) }) }],
              details: { kind: 'mcp', serverId: id, serverName: config.name, remoteTool: remote.name, configRevision: revision, complete } };
          } finally { context.abortSignal?.removeEventListener('abort', cancel); }
        },
      });
    });
    const extension = defineExtension({ name: 'arxd-mcp-' + id, tools: registrations });
    this.requireHttpPolicy(this.get(id));
    this.registry.install(extension); this.catalog.set(id, { tools, revision: connection.toolsRevision!, connectionId: connection.connectionId!, configRevision: revision, binding, token, aliases, extension }); this.changed();
    return { tools, catalogId: token, aliases: registrations.map((tool) => tool.name) };
  }
  async tools(id: string, query: string, offset: number, signal?: AbortSignal) {
    if (query.length > 512 || !Number.isInteger(offset) || offset < 0 || offset > 256) throw new Error('Invalid MCP tool query');
    const current = this.catalog.get(id);
    const native = (await this.host.mcpStates()).find((state) => state.id === id);
    this.requireHttpPolicy(this.get(id));
    if (!this.get(id).enabled) throw new Error('MCP server is disabled');
    if (!current || !native?.enabled || native.state !== 'connected' || current.revision !== (native.toolsRevision ?? 0) || current.connectionId !== native.connectionId || current.token !== native.catalogId || current.configRevision !== this.get(id).revision) await this.discover(id, signal);
    this.requireHttpPolicy(this.get(id));
    const selected = this.catalog.get(id)!.tools.filter((tool) => `${tool.name}\n${tool.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    const page = selected.slice(offset, offset + 8);
    while (page.length && bytes(page) > 131072) page.pop();
    if (!page.length && offset < selected.length) throw new Error('One MCP tool definition exceeds the page budget');
    return { tools: page.map((tool) => ({ ...tool, alias: this.catalog.get(id)!.aliases.get(tool.name)!, logicalToolId: `${id}/${tool.name}`, catalogId: this.catalog.get(id)!.token })), total: selected.length,
      complete: offset + page.length >= selected.length, nextOffset: offset + page.length < selected.length ? offset + page.length : null };
  }
  disconnect(id: string) { return this.queue(async () => {
    this.get(id); this.clearTools(id);
    const state = await this.host.mcpDisconnect(id); this.changed(); return state;
  }); }
  remove(id: string) { return this.queue(async () => {
    this.get(id); await this.host.mcpEnabled(id, false).catch(() => undefined); await this.host.mcpDisconnect(id).catch(() => undefined);
    this.clearTools(id); await this.host.credentials.remove(id);
    this.configurations.delete(id); this.errors.delete(id);
    if (this.store) {
      const servers: Record<string, PiServer> = {};
      for (const current of this.configurations.values()) servers[current.name] = toPi(current);
      this.configSha = (await this.store.write(JSON.stringify({ mcpServers: servers }, null, 2) + '\n', this.configSha)).sha256;
    } else await this.db.run('DELETE FROM arxd_mcp WHERE id=?', id);
    this.changed();
  }); }
}
