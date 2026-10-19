import { localProvider, LOCAL_MODEL, LOCAL_PROVIDER_ID, PINNED_MODEL_ID, isLocalModelId, localDefinition, type LocalModelHost } from '../agent/local-provider.ts';
import { wrapRetryProvider } from '../agent/request-retry.ts';
import { lazyStream, validateToolArguments, type Api, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions, type ToolCall } from '@earendil-works/pi-ai';
import { createModels, createProvider, getSupportedThinkingLevels, type MutableModels } from '@earendil-works/pi-ai/models';
import type { PiAccountEvent, PiAccountHost, PiAccountProvider, PiAccountStatus } from './pi-account.ts';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { OPENAI_CODEX_MODELS } from '@earendil-works/pi-ai/providers/openai-codex.models';
import { KIMI_CODING_MODELS } from '@earendil-works/pi-ai/providers/kimi-coding.models';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import { OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema, AnthropicMessagesCompatSchema } from '@earendil-works/pi-ai/providers/compat-schema';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';

export const PROTOCOLS = ['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type Protocol = typeof PROTOCOLS[number];
export const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai-completions', endpoint: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com' },
  { id: 'google', name: 'Google Gemini', protocol: 'google-generative-ai', endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'custom', name: '自定义接口', protocol: 'openai-completions', endpoint: '' },
  { id: 'openai-codex', name: 'OpenAI Codex', protocol: 'openai-codex-responses', endpoint: 'https://chatgpt.com/backend-api', account: 'openai-codex' },
  { id: 'kimi-coding', name: 'Kimi Code', protocol: 'openai-completions', endpoint: 'https://api.kimi.com/coding/v1', account: 'kimi-coding' },
  { id: 'xai', name: 'xAI Grok', protocol: 'openai-responses', endpoint: 'https://api.x.ai/v1', account: 'xai' },
] as const;
export type Preset = typeof PRESETS[number]['id'];
export const ACCOUNT_PRESETS = PRESETS.filter((preset): preset is Extract<typeof PRESETS[number], { account: PiAccountProvider }> => 'account' in preset);
export type ConnectionAuth = 'key' | 'none' | 'account';
export type ConnectionSecret = { apiKey?: string; headers?: Record<string, string> };
export type ConnectionHost = { get(id: string): Promise<ConnectionSecret | undefined>; put(id: string, secret: ConnectionSecret): Promise<void>; remove(id: string): Promise<void> };
export type Generation = { maxTokens?: number; temperature?: number; cacheRetention?: 'none' | 'short' | 'long'; samplingParams?: Record<string, number>; timeoutMs?: number };
export type Connection = { id: string; name: string; preset: Preset; protocol: Protocol; endpoint: string; auth: ConnectionAuth; account?: PiAccountProvider; status: 'active' | 'deleting' | 'deleted'; revision: number; test?: { ok: boolean; at: number; model: string; durationMs: number; error?: string } };
export type ConnectionView = Connection & { hasCredential: boolean; credentialError: boolean; accountStatus?: PiAccountStatus };
export type ConfiguredModel = { id: string; connectionId: string; definition: Model<Api>; enabled: boolean; source: 'catalog' | 'manual'; generation: Generation };
export type ModelChoice = { id: string; label: string; connection: string; connectionId?: string; context: number; thinking: ModelThinkingLevel[]; available: boolean; offline: boolean };
export function modelCapabilities(model: Model<Api>) {
  const compat = model.compat as { supportsTemperature?: boolean; supportsMidConvoEffort?: boolean; cacheControlFormat?: string } | undefined;
  return { temperature: compat?.supportsTemperature !== false && !(model.api === 'anthropic-messages' && compat?.supportsMidConvoEffort), sampling: model.api.startsWith('openai-'), cache: model.api === 'anthropic-messages' || model.api === 'openai-responses' || compat?.cacheControlFormat === 'anthropic' };
}
const catalogs = { deepseek: Object.values(DEEPSEEK_MODELS), openai: Object.values(OPENAI_MODELS), anthropic: Object.values(ANTHROPIC_MODELS), google: Object.values(GOOGLE_MODELS), custom: [], 'openai-codex': Object.values(OPENAI_CODEX_MODELS), 'kimi-coding': Object.values(KIMI_CODING_MODELS), xai: Object.values(XAI_MODELS) };
const apis: Record<Protocol, () => ProviderStreams> = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'openai-codex-responses': openAICodexResponsesApi, 'anthropic-messages': anthropicMessagesApi, 'google-generative-ai': googleGenerativeAIApi };
const schemas = { 'openai-completions': OpenAICompletionsCompatSchema, 'openai-responses': OpenAIResponsesCompatSchema, 'openai-codex-responses': OpenAIResponsesCompatSchema, 'anthropic-messages': AnthropicMessagesCompatSchema };
const bounded = (value: unknown, limit = 8192) => { if (new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error('配置超过大小限制'); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function name(value: string, limit = 128) { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error('名称或模型 ID 无效'); return value.trim(); }
function number(value: unknown, min: number, max: number, integer = false) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`参数须在 ${min}–${max} 之间`); }
function endpoint(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new Error('Endpoint 须为不含凭据、查询参数或片段的 HTTP(S) 地址');
  return url.toString().replace(/\/$/, '');
}
export function validateSecret(secret: ConnectionSecret) {
  if (!plain(secret) || Object.keys(secret).some((key) => !['apiKey', 'headers'].includes(key))) throw new Error('凭据格式无效');
  if (secret.apiKey !== undefined && (typeof secret.apiKey !== 'string' || !secret.apiKey.trim() || secret.apiKey.length > 2048 || /\s/.test(secret.apiKey))) throw new Error('API Key 不能为空或包含空白');
  if (secret.headers !== undefined && (!plain(secret.headers) || Object.keys(secret.headers).length > 16 || Object.entries(secret.headers).some(([key, value]) => !/^[a-zA-Z0-9-]{1,128}$/.test(key) || typeof value !== 'string' || /[\r\n\x00]/.test(value) || value.length > 2048))) throw new Error('请求头格式无效');
  if (Object.keys(secret.headers ?? {}).some((key) => /^(host|content-length|connection)$/i.test(key))) throw new Error('不能覆盖传输协议请求头');
  bounded(secret, 8192); return secret;
}
export function validateGeneration(value: Generation, model: Model<Api>): Generation {
  if (!plain(value) || Object.keys(value).some((key) => !['maxTokens', 'temperature', 'cacheRetention', 'samplingParams', 'timeoutMs'].includes(key))) throw new Error('生成参数无效');
  if (value.maxTokens !== undefined) number(value.maxTokens, model.api === 'openai-responses' || model.api === 'openai-codex-responses' ? 16 : 1, model.maxTokens, true);
  if (value.temperature !== undefined) { number(value.temperature, 0, model.api === 'anthropic-messages' ? 1 : 2); if (!modelCapabilities(model).temperature) throw new Error('此模型不支持温度参数'); }
  if (value.cacheRetention !== undefined && (!modelCapabilities(model).cache || !['none', 'short', 'long'].includes(value.cacheRetention))) throw new Error('缓存保留参数无效或此协议不支持');
  if (value.timeoutMs !== undefined) number(value.timeoutMs, 1000, 300000, true);
  if (value.samplingParams !== undefined) {
    if (!model.api.startsWith('openai-') || !plain(value.samplingParams)) throw new Error('此协议不支持额外采样参数');
    const ranges: Record<string, [number, number]> = { top_p: [0, 1], top_k: [0, 100000], min_p: [0, 1], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], repetition_penalty: [0, 10], seed: [-2147483648, 2147483647] };
    for (const [key, item] of Object.entries(value.samplingParams)) { if (!ranges[key]) throw new Error(`不支持的采样参数：${key}`); number(item, ...ranges[key], key === 'top_k' || key === 'seed'); }
  }
  bounded(value); return structuredClone(value);
}
export function manualModel(connection: Connection, input: { id: string; name: string; contextWindow: number; maxTokens: number; thinking: ModelThinkingLevel[]; compat?: unknown }): Model<Api> {
  const id = name(input.id, 256); const label = name(input.name);
  number(input.contextWindow, 8192, 10000000, true); number(input.maxTokens, 16, input.contextWindow, true);
  const levels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!Array.isArray(input.thinking) || !input.thinking.length || input.thinking.some((level) => !levels.includes(level))) throw new Error('请选择有效的思考等级');
  let compat: Model<Api>['compat'];
  if (input.compat !== undefined) {
    if (connection.protocol === 'google-generative-ai' || !plain(input.compat)) throw new Error('此协议不支持兼容选项');
    bounded(input.compat);
    const schema = { ...schemas[connection.protocol], additionalProperties: false };
    compat = validateToolArguments({ name: 'compat', description: '', parameters: schema }, { type: 'toolCall', id: 'config', name: 'compat', arguments: input.compat as ToolCall['arguments'] });
  }
  return { id, name: label, provider: connection.id, api: connection.protocol, baseUrl: connection.endpoint, input: ['text'], reasoning: input.thinking.some((level) => level !== 'off'), thinkingLevelMap: Object.fromEntries(levels.map((level) => [level, input.thinking.includes(level) ? level : null])), contextWindow: input.contextWindow, maxTokens: input.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(compat ? { compat } : {}) };
}

/** App-owned non-secret configuration, separate encrypted credentials, and connection-scoped providers. */
export class ConnectionLibrary {
  readonly models: MutableModels = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  private records = new Map<string, Connection>();
  private entries = new Map<string, ConfiguredModel>();
  private knownSecrets = new Set<string>();
  private probes = new Set<string>();
  private authenticated = new Map<string, boolean>();
  private credentialErrors = new Set<string>();
  private db: SqliteDatabase;
  private secrets?: ConnectionHost;
  private accounts?: PiAccountHost;
  private request?: typeof globalThis.fetch;
  private legacyKey?: () => Promise<string | undefined>;
  readonly local?: LocalModelHost;
  constructor(db: SqliteDatabase, secrets?: ConnectionHost, request?: typeof globalThis.fetch, legacyKey?: () => Promise<string | undefined>, accounts?: PiAccountHost, local?: LocalModelHost) { this.db = db; this.secrets = secrets; this.request = request; this.legacyKey = legacyKey; this.accounts = accounts; this.local = local; }
  async open() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS arxd_connections (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS arxd_models (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, upstream_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(connection_id,upstream_id));
      CREATE TABLE IF NOT EXISTS arxd_connections_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const version = await this.db.get<{ value: string }>("SELECT value FROM arxd_connections_meta WHERE key='version'");
    if (version && version.value !== '1') throw new Error('Unsupported model configuration schema');
    if (!version) await this.db.transaction(async (tx) => {
      const preset = PRESETS[0];
      const connection: Connection = { id: 'deepseek', name: 'DeepSeek', preset: preset.id, protocol: preset.protocol, endpoint: preset.endpoint, auth: 'key', status: 'active', revision: 1 };
      const model = DEEPSEEK_MODELS['deepseek-flash'];
      const entry: ConfiguredModel = { id: 'deepseek', connectionId: 'deepseek', definition: { ...model, name: 'DeepSeek Flash' }, enabled: true, source: 'catalog', generation: { maxTokens: model.maxTokens } };
      await tx.run('INSERT INTO arxd_connections (id,value) VALUES (?,?)', connection.id, JSON.stringify(connection));
      await tx.run('INSERT INTO arxd_models (id,connection_id,upstream_id,value) VALUES (?,?,?,?)', entry.id, entry.connectionId, model.id, JSON.stringify(entry));
      await tx.run("INSERT INTO arxd_connections_meta (key,value) VALUES ('version','1')");
    });
    await this.reload();
    await this.upgradeGenerationDefaults();
    for (const connection of this.records.values()) if (connection.status === 'deleting') { try { await this.remove(connection.id); } catch { /* Retain retryable deletion state. */ } }
  }
  /** Persist Pi's model output ceiling instead of leaving budgets blank or on Arxd's former 2K/4K catalog defaults. */
  private async upgradeGenerationDefaults() {
    const marker = await this.db.get<{ value: string }>("SELECT value FROM arxd_connections_meta WHERE key='generation-defaults'");
    if (marker?.value === '2') return;
    const migrated = [...this.entries.values()].filter((entry) => {
      if (entry.generation.maxTokens === undefined) return true;
      return entry.source === 'catalog' && Object.keys(entry.generation).length === 1 && (entry.generation.maxTokens === 2048 || entry.generation.maxTokens === 4096);
    });
    if (migrated.length) await this.db.transaction(async (tx) => {
      for (const entry of migrated) {
        const generation = { ...entry.generation, maxTokens: entry.definition.maxTokens };
        await tx.run('INSERT OR REPLACE INTO arxd_models (id,connection_id,upstream_id,value) VALUES (?,?,?,?)', entry.id, entry.connectionId, entry.definition.id, JSON.stringify({ ...entry, generation }));
      }
    });
    await this.db.run("INSERT OR REPLACE INTO arxd_connections_meta (key,value) VALUES ('generation-defaults','2')");
    if (migrated.length) await this.reload();
  }
  private async reload() {
    this.records = new Map((await this.db.all<{ value: string }>("SELECT value FROM arxd_connections WHERE json_extract(value,'$.status') != 'deleted' LIMIT 129")).map(({ value }) => { const row = JSON.parse(value) as Connection; return [row.id, row]; }));
    this.entries = new Map((await this.db.all<{ value: string }>('SELECT value FROM arxd_models LIMIT 2049')).map(({ value }) => { const row = JSON.parse(value) as ConfiguredModel; return [row.id, row]; }));
    if (this.records.size > 128 || this.entries.size > 2048) throw new Error('Model configuration exceeds budget');
    for (const provider of this.models.getProviders()) if (provider.id !== 'faux' && provider.id !== LOCAL_PROVIDER_ID) this.models.deleteProvider(provider.id);
    if (this.local) this.models.setProvider(localProvider(this.local));
    for (const connection of this.records.values()) if (connection.status === 'active') this.register(connection);
    await Promise.all([...this.records.values()].filter((connection) => connection.status === 'active').map(async (connection) => {
      if (connection.auth === 'account' && connection.account) {
        try {
          const status = await this.accounts?.status(connection.account);
          this.authenticated.set(connection.id, !!status?.signedIn);
          this.credentialErrors.delete(connection.id);
        } catch {
          this.authenticated.set(connection.id, false);
          this.credentialErrors.add(connection.id);
        }
      } else {
        await this.secret(connection.id).catch(() => undefined);
      }
    }));
  }
  private async secret(id: string) {
    let value: ConnectionSecret | undefined;
    try {
      const stored = await this.secrets?.get(id);
      value = this.secrets ? stored : id === 'deepseek' ? { apiKey: await this.legacyKey?.() } : undefined;
      if (value) validateSecret(value);
    } catch {
      this.authenticated.set(id, false); this.credentialErrors.add(id);
      throw new Error('设备凭据无法读取，请清除后重新配置');
    }
    this.credentialErrors.delete(id);
    this.authenticated.set(id, !!value?.apiKey || !!Object.keys(value?.headers ?? {}).length);
    for (const item of [value?.apiKey, ...Object.values(value?.headers ?? {})]) if (item) this.knownSecrets.add(item);
    return value;
  }
  redact(value: unknown) {
    let text = String(value);
    for (const secret of this.knownSecrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1000);
  }
  private register(connection: Connection) {
    const definitions = [...this.entries.values()].filter((entry) => entry.connectionId === connection.id).map((entry) => ({ ...entry.definition, provider: connection.id, baseUrl: connection.endpoint, api: connection.protocol }));
    const api = apis[connection.protocol]();
    const options = (model: Model<Api>, original: SimpleStreamOptions = {}) => {
      const entry = [...this.entries.values()].find((item) => item.connectionId === connection.id && item.definition.id === model.id);
      return { ...original, ...entry?.generation, maxTokens: original.maxTokens ?? entry?.generation.maxTokens, ...(entry && this.probes.has(entry.id) ? { maxTokens: 16, timeoutMs: 20000, maxRetries: 0, reasoning: undefined, temperature: undefined, samplingParams: undefined } : {}), fetch: connection.protocol === 'google-generative-ai' ? undefined : original.fetch ?? this.request, transport: 'sse' as const };
    };
    const sanitize = (model: Model<Api>, stream: ReturnType<ProviderStreams['stream']>) => lazyStream(model, async () => {
      const redact = (error: unknown) => this.redact(error);
      return (async function* () { try { for await (const event of stream) { if (event.type === 'error' && event.error.errorMessage) event.error.errorMessage = redact(event.error.errorMessage); yield event; } } catch (error) { throw new Error(redact(error)); } })();
    });
    this.models.setProvider(wrapRetryProvider(createProvider({ id: connection.id, name: connection.name, baseUrl: connection.endpoint,
      auth: { apiKey: { name: connection.auth === 'account' ? 'Pi account' : 'Device credential', resolve: async () => {
        if (connection.auth === 'none') return { auth: { apiKey: 'arxd-keyless-local', headers: { authorization: null, 'x-api-key': null } }, source: 'No authentication' };
        if (connection.auth === 'account' && connection.account) {
          const token = await this.accounts?.token(connection.account);
          if (!token?.apiKey && !Object.keys(token?.headers ?? {}).length) return undefined;
          return { auth: { ...token }, source: 'Pi account' };
        }
        const secret = await this.secret(connection.id);
        if (connection.auth === 'key' && !secret?.apiKey && !Object.keys(secret?.headers ?? {}).length) return undefined;
        return { auth: { apiKey: secret?.apiKey ?? 'arxd-header-auth', headers: secret?.headers }, source: 'Device credential' };
      } } }, models: definitions, api: { stream: (model, context, original) => sanitize(model, api.stream(model, context, options(model, original))), streamSimple: (model, context, original) => sanitize(model, api.streamSimple(model, context, options(model, original))) },
    }), this.request, (model, original) => options(model, original).timeoutMs));
  }
  async list(): Promise<ConnectionView[]> { return Promise.all([...this.records.values()].filter((item) => item.status !== 'deleted').map(async (item) => {
    if (item.auth === 'account' && item.account) {
      try {
        const status = await this.accounts?.status(item.account) ?? { signedIn: false };
        this.authenticated.set(item.id, status.signedIn);
        return { ...structuredClone(item), hasCredential: status.signedIn, credentialError: this.credentialErrors.has(item.id), accountStatus: status };
      } catch {
        return { ...structuredClone(item), hasCredential: false, credentialError: true, accountStatus: { signedIn: false } };
      }
    }
    const secret = await this.secret(item.id).catch(() => undefined);
    return { ...structuredClone(item), hasCredential: !!secret?.apiKey || !!Object.keys(secret?.headers ?? {}).length, credentialError: this.credentialErrors.has(item.id) };
  })); }
  get(id: string) { const value = this.records.get(id); if (!value) throw new Error('连接不存在'); return structuredClone(value); }
  configured(id?: string) { return [...this.entries.values()].filter((entry) => !id || entry.connectionId === id).map((entry) => structuredClone(entry)); }
  catalog(id: string, query = '') { const connection = this.get(id); return catalogs[connection.preset].filter((model) => model.api === connection.protocol && `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase())).map((model) => structuredClone(model)); }
  /** Fetch every model the endpoint advertises and add missing entries. Known Pi catalog models keep their capabilities; unknown IDs get editable defaults. */
  async discoverModels(connectionId: string, signal?: AbortSignal) {
    const connection = this.get(connectionId);
    if (connection.status !== 'active') throw new Error('连接不可用');
    const secret = await this.secret(connectionId);
    if (connection.auth === 'key' && !secret?.apiKey && !Object.keys(secret?.headers ?? {}).length) throw new Error('请先保存此连接的 API Key 或请求头');
    const headers: Record<string, string> = { ...(secret?.headers ?? {}) };
    const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
    if (secret?.apiKey) {
      if (connection.protocol === 'anthropic-messages') { headers['x-api-key'] = secret.apiKey; headers['anthropic-version'] ??= '2023-06-01'; }
      else if (connection.protocol === 'google-generative-ai') headers['x-goog-api-key'] = secret.apiKey;
      else if (!hasAuthorization) headers.Authorization = `Bearer ${secret.apiKey}`;
    }
    const base = connection.endpoint.replace(/\/$/, '');
    const url = connection.protocol === 'anthropic-messages'
      ? `${base}${/\/v1$/.test(base) ? '' : '/v1'}/models`
      : connection.protocol === 'google-generative-ai'
        ? `${/\/v\d+(?:beta)?$/.test(base) ? base : `${base}/v1beta`}/models`
        : `${base}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await (this.request ?? globalThis.fetch)(url, { method: 'GET', headers, signal: controller.signal });
      if (!response.ok) throw new Error(`模型发现请求失败（HTTP ${response.status}）`);
      const payload = await response.json() as Record<string, unknown>;
      const raw = connection.protocol === 'google-generative-ai' ? payload.models : Array.isArray(payload.data) ? payload.data : payload.models;
      if (!Array.isArray(raw)) throw new Error('模型发现响应缺少模型列表');
      const discovered: { id: string; name: string }[] = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const rawId = typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : '';
        const id = rawId.replace(/^models\//, '').trim();
        if (!id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) continue;
        if (connection.protocol === 'google-generative-ai' && Array.isArray(value.supportedGenerationMethods) && !value.supportedGenerationMethods.includes('generateContent')) continue;
        if (/(^|[-_/])(embedding|moderation|transcribe|tts|dall-e|whisper|image)([-_/]|$)/i.test(id)) continue;
        const resourceName = typeof value.name === 'string' ? value.name.replace(/^models\//, '').trim() : '';
        const name = (typeof value.display_name === 'string' ? value.display_name
          : typeof value.displayName === 'string' ? value.displayName
          : resourceName && resourceName !== id ? resourceName : id).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 128) || id;
        if (!discovered.some((entry) => entry.id === id)) discovered.push({ id, name });
      }
      if (!discovered.length) throw new Error('接口没有返回可添加的模型');
      let added = 0;
      for (const item of discovered) {
        if ([...this.entries.values()].some((entry) => entry.connectionId === connectionId && entry.definition.id === item.id)) continue;
        const known = catalogs[connection.preset].find((model) => model.id === item.id && model.api === connection.protocol);
        if (known) {
          await this.putModel(connectionId, known, 'catalog', { maxTokens: known.maxTokens }, true);
        } else {
          const definition = manualModel(connection, { id: item.id, name: item.name, contextWindow: 128000, maxTokens: 16384, thinking: ['off'] });
          await this.putModel(connectionId, definition, 'manual', { maxTokens: definition.maxTokens }, true);
        }
        added++;
      }
      return { discovered: discovered.length, added };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? '模型发现已取消' : '模型发现超时');
      throw new Error(this.redact(error));
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  }
  choices(): ModelChoice[] {
    const choices = [...this.entries.values()].filter((entry) => entry.enabled && this.records.get(entry.connectionId)?.status === 'active').map((entry) => ({ id: entry.id, label: entry.definition.name, connectionId: entry.connectionId, connection: this.records.get(entry.connectionId)!.name, context: entry.definition.contextWindow, thinking: getSupportedThinkingLevels(entry.definition), available: this.records.get(entry.connectionId)?.auth === 'none' || !!this.authenticated.get(entry.connectionId), offline: false }));
    if (!this.local) return choices;
    const installed = this.local.status().models;
    const local = installed.map((record) => ({ id: record.id, label: record.name, connection: '端侧模型', context: record.contextWindow, thinking: (record.thinking ? ['off', 'medium'] : ['off']) as ModelThinkingLevel[], available: record.available, offline: true }));
    const pinned = installed.some((record) => record.id === PINNED_MODEL_ID) ? [] : [{ id: PINNED_MODEL_ID, label: LOCAL_MODEL.name, connection: '端侧模型', context: LOCAL_MODEL.contextWindow, thinking: ['off'] as ModelThinkingLevel[], available: false, offline: true }];
    return [...choices, ...local, ...pinned];
  }
  resolve(id: string) {
    if (this.local && isLocalModelId(id)) {
      const record = this.local.status().models.find((model) => model.id === id);
      if (!record || !record.available) throw new Error('端侧模型文件缺失，请重新下载或导入');
      const definition = localDefinition(record);
      return { ref: { provider: LOCAL_PROVIDER_ID, modelId: definition.id }, thinking: (record.thinking ? ['off', 'medium'] : ['off']) as ModelThinkingLevel[], label: definition.name };
    }
    if (id === 'test') return { ref: { provider: 'faux', modelId: 'faux-1' }, thinking: ['off'] as ModelThinkingLevel[], label: '测试模型' };
    const entry = this.entries.get(id); const connection = entry && this.records.get(entry.connectionId);
    if (!entry?.enabled || connection?.status !== 'active') throw new Error('当前模型已停用或连接已删除，请选择其他模型');
    return { ref: { provider: entry.connectionId, modelId: entry.definition.id }, thinking: getSupportedThinkingLevels(entry.definition), label: entry.definition.name };
  }
  label(id?: string) {
    if (isLocalModelId(id)) { const record = this.local?.status().models.find((model) => model.id === id); return record ? record.name : LOCAL_MODEL.name; }
    return !id ? '未配置模型' : id === 'test' ? '测试模型' : this.entries.get(id)?.definition.name ?? '模型不可用';
  }
  responseLabel(provider: string, model: string) {
    if (provider === LOCAL_PROVIDER_ID) {
      const record = this.local?.status().models.find((entry) => localDefinition(entry).id === model);
      return record ? record.name : LOCAL_MODEL.name;
    }
    return provider === 'faux' ? '测试模型' : [...this.entries.values()].find((entry) => entry.connectionId === provider && entry.definition.id === model)?.definition.name ?? model;
  }
  async available(id: string) {
    const model = this.resolve(id);
    if (this.local && isLocalModelId(id)) return model;
    if (id !== 'test' && !await this.models.checkAuth(model.ref.provider)) throw new Error('请先保存此连接的 API Key 或请求头');
    return model;
  }
  /** Local inventory lives in native storage; rebuild provider/model choices after import or deletion. */
  async refreshLocal() { await this.reload(); }
  private async store(value: Connection) { await this.db.run('INSERT OR REPLACE INTO arxd_connections (id,value) VALUES (?,?)', value.id, JSON.stringify(value)); await this.reload(); return structuredClone(value); }
  async save(input: Pick<Connection, 'name' | 'preset' | 'protocol' | 'endpoint' | 'auth'>, id?: string, revision?: number) {
    if (!PRESETS.some((preset) => preset.id === input.preset) || !PROTOCOLS.includes(input.protocol) || !['key', 'none', 'account'].includes(input.auth)) throw new Error('连接协议或认证方式无效');
    if (input.protocol === 'google-generative-ai' && input.auth === 'none') throw new Error('Google 协议需要 API Key');
    const account = (PRESETS.find((preset) => preset.id === input.preset) as { account?: PiAccountProvider } | undefined)?.account;
    if (input.auth === 'account' && !account) throw new Error('此连接不支持账号登录');
    if (input.auth !== 'account' && account) throw new Error('账号登录连接必须使用账号认证');
    const old = id ? this.get(id) : undefined;
    if (old && (old.status !== 'active' || old.revision !== revision)) throw new Error('连接已更改，请重新打开');
    if (!old && [...this.records.values()].filter((item) => item.status !== 'deleted').length >= 32) throw new Error('最多管理 32 个连接');
    if (old && input.protocol !== old.protocol && this.configured(id).length) throw new Error('已有模型的连接不能修改协议，请新建连接');
    return this.store({ id: old?.id ?? globalThis.crypto.randomUUID(), name: name(input.name), preset: input.preset, protocol: input.protocol, endpoint: endpoint(input.endpoint), auth: input.auth, ...(account ? { account } : {}), status: 'active', revision: (old?.revision ?? 0) + 1 });
  }
  async credential(id: string, value: ConnectionSecret | null) {
    const connection = this.get(id); if (connection.auth === 'account') throw new Error('账号连接请使用账号登录'); if (connection.status !== 'active' || !this.secrets) throw new Error('凭据存储不可用');
    if (value) { const merged = validateSecret({ ...await this.secret(id), ...value }); if (!merged.apiKey && !Object.keys(merged.headers ?? {}).length) throw new Error('请填写 API Key 或请求头'); await this.secrets.put(id, merged); } else await this.secrets.remove(id);
    await this.store({ ...connection, revision: connection.revision + 1, test: undefined });
  }
  async putModel(connectionId: string, definition: Model<Api>, source: ConfiguredModel['source'], generation: Generation = {}, enabled = true, identity?: string) {
    const connection = this.get(connectionId); if (connection.status !== 'active') throw new Error('连接不可用');
    if (definition.api !== connection.protocol) throw new Error('模型协议与连接不一致');
    const old = [...this.entries.values()].find((entry) => entry.connectionId === connectionId && entry.definition.id === definition.id);
    if (identity && (!this.entries.has(identity) || this.entries.get(identity)?.connectionId !== connectionId || old?.id !== identity)) throw new Error('编辑时不能修改模型 ID');
    if (!old && this.configured().length >= 1024) throw new Error('最多配置 1024 个模型');
    const budget = generation.maxTokens === undefined ? { ...generation, maxTokens: definition.maxTokens } : generation;
    const value: ConfiguredModel = { id: old?.id ?? globalThis.crypto.randomUUID(), connectionId, definition: { ...structuredClone(definition), provider: connectionId, baseUrl: connection.endpoint }, source, generation: validateGeneration(budget, definition), enabled };
    bounded(value, 32768);
    await this.db.run('INSERT OR REPLACE INTO arxd_models (id,connection_id,upstream_id,value) VALUES (?,?,?,?)', value.id, connectionId, definition.id, JSON.stringify(value));
    await this.store({ ...connection, revision: connection.revision + 1, test: undefined }); return structuredClone(value);
  }
  /** Sign in to a Pi account provider and create/update its account connection. */
  async loginAccount(provider: PiAccountProvider, onEvent?: (event: PiAccountEvent) => void, signal?: AbortSignal) {
    if (!this.accounts) throw new Error('账号登录不可用');
    const preset = ACCOUNT_PRESETS.find((item) => item.account === provider);
    if (!preset) throw new Error('不支持此账号登录');
    let connection = [...this.records.values()].find((item) => item.status === 'active' && item.auth === 'account' && item.account === provider);
    const created = !connection;
    connection ??= await this.save({ name: preset.name, preset: preset.id, protocol: preset.protocol, endpoint: preset.endpoint, auth: 'account' });
    try {
      const status = await this.accounts.status(provider).catch(() => undefined);
      if (!status?.signedIn) await this.accounts.login(provider, onEvent, signal);
      const existing = new Set(this.configured(connection.id).map((entry) => entry.definition.id));
      for (const definition of this.catalog(connection.id)) if (!existing.has(definition.id)) await this.addCatalog(connection.id, definition.id);
      await this.reload();
      return { id: connection.id, created };
    } catch (error) {
      if (created) await this.remove(connection.id).catch(() => undefined);
      throw error;
    }
  }

  async logoutAccount(id: string) {
    const connection = this.get(id);
    if (connection.auth !== 'account' || !connection.account || !this.accounts) throw new Error('此连接不是账号连接');
    await this.accounts.logout(connection.account);
    await this.reload();
  }

  async addCatalog(connectionId: string, modelId: string) { const definition = this.catalog(connectionId).find((item) => item.id === modelId); if (!definition) throw new Error('目录模型不存在'); return this.putModel(connectionId, definition, 'catalog', { maxTokens: definition.maxTokens }); }
  async manual(connectionId: string, input: Parameters<typeof manualModel>[1], generation: Generation, enabled: boolean, identity?: string) { return this.putModel(connectionId, manualModel(this.get(connectionId), input), 'manual', generation, enabled, identity); }
  async updateModel(id: string, generation: Generation, enabled: boolean) { const old = this.entries.get(id); if (!old) throw new Error('模型不存在'); return this.putModel(old.connectionId, old.definition, old.source, generation, enabled, id); }
  async remove(id: string) {
    if (!this.records.has(id)) return;
    const connection = this.get(id); if (connection.status === 'deleted') return;
    await this.store({ ...connection, status: 'deleting', revision: connection.revision + 1, test: undefined });
    if (connection.auth === 'account' && connection.account) {
      if (!this.accounts) throw new Error('账号登录不可用');
      await this.accounts.logout(connection.account);
    } else {
      if (!this.secrets) throw new Error('凭据存储不可用');
      await this.secrets.remove(id);
    }
    await this.store({ ...connection, status: 'deleted', revision: connection.revision + 1, test: undefined });
  }
  async test(modelId: string, signal?: AbortSignal) {
    const { ref } = await this.available(modelId); const entry = this.entries.get(modelId)!; const connection = this.get(ref.provider); const started = Date.now();
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, 20000);
    this.probes.add(modelId);
    let result: NonNullable<Connection['test']>;
    try {
      const model = this.models.getModel(ref.provider, ref.modelId)!;
      const message = await this.models.completeSimple(model, { messages: [{ role: 'user', content: 'Reply only OK.', timestamp: Date.now() }] }, { maxTokens: 16, timeoutMs: 20000, maxRetries: 0, signal: controller.signal });
      if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? '连接请求失败');
      if (!message.content.some((part) => part.type === 'text' && part.text.trim())) throw new Error('接口未返回文本');
      result = { ok: true, at: Date.now(), model: entry.definition.id, durationMs: Date.now() - started };
    } catch (error) { result = { ok: false, at: Date.now(), model: entry.definition.id, durationMs: Date.now() - started, error: this.redact(error) }; }
    finally { this.probes.delete(modelId); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    if (this.get(connection.id).revision === connection.revision) await this.store({ ...connection, test: result });
    return result;
  }
}
