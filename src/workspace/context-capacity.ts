import { BACKGROUND_CONTEXT, withCancel, type Context } from '@earendil-works/chord/context';
import type { AssistantMessage, Message, Model, Usage } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import { calculateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { GenerationTask, InboxDoc, defineDocFamily, defineExtension, hook, type Agent, type CompactionPolicy, type ContextView, type Conversation, type ConversationId, type Harness, type CommitPublication } from '@earendil-works/pi-durable';

/** Independently estimated parts of the prepared request, largest accounting first. */
export type ContextPart = { key: 'system' | 'skills' | 'mcp' | 'tools' | 'user' | 'assistant' | 'toolResult' | 'other'; tokens: number };

/** Pi 1.3-compatible accounting adapter; never import private durable helpers. */
export type ContextCapacity = {
  conversationId: string | null; model: { provider: string; id: string; revision: string; limitSource: 'model-configuration' | 'manual' | 'catalog' } | null;
  state: 'pending' | 'current' | 'stale' | 'unavailable'; basis: 'last-committed-context';
  tokens: number | null; limit: number | null; ratio: number | null; remaining: number | null; parts: ContextPart[];
  source: 'estimate' | 'provider-anchored-estimate' | null; usageTokens: number; trailingTokens: number;
  configurationRevision: string | null; revision: string | null; head: number | null; reason: string | null;
  thresholds: { background: number | null; blocking: number | null; reserve: number; enabled: boolean; actionable: boolean };
  summaryPending: boolean;
  anchorDiagnostics?: { checked: number; selected: boolean; last?: { saved: boolean; position: number; head: boolean; configuration: boolean; prompt: boolean; prefix: boolean } };
  emphasis: 'normal' | 'background' | 'blocking' | 'over-limit';
};
const emptyThresholds = { background: null, blocking: null, reserve: 0, enabled: false, actionable: false };
export const unknownCapacity = (conversationId: string | null = null): ContextCapacity => ({ conversationId, model: null, state: 'unavailable', basis: 'last-committed-context', tokens: null, limit: null, ratio: null, remaining: null, parts: [], source: null, usageTokens: 0, trailingTokens: 0, configurationRevision: null, revision: null, head: null, reason: 'No committed conversation context', summaryPending: false, thresholds: emptyThresholds, emphasis: 'normal' });
const MESSAGE_LIMIT = 16384, CHARACTER_LIMIT = 8 * 1024 * 1024, WORK_MS = 150, READ_MS = 500;
// Bound admission before serialization: timers cannot preempt JSON.stringify.
const VALUE_LIMIT = 1024 * 1024, DEPTH_LIMIT = 64, FIELD_LIMIT = 262144;
type Work = { started: number; fields: number };
function work(): Work { return { started: performance.now(), fields: 0 }; }
function checkWork(budget: Work) { if (performance.now() - budget.started > WORK_MS) throw new Error('Context estimate exceeds 150 ms work budget'); }
function serialize(value: unknown, budget: Work, remaining = CHARACTER_LIMIT): string {
  const limit = Math.min(VALUE_LIMIT, remaining);
  const reason = limit === VALUE_LIMIT ? 'Context estimate exceeds single JSON value budget (1,048,576 code units)' : 'Context estimate exceeds aggregate JSON budget (8,388,608 code units)';
  let chars = 0;
  const path = new WeakSet<object>();
  const add = (count: number) => { chars += count; if (chars > limit) throw new Error(reason); };
  function string(text: string) {
    // This O(1) check rejects enormous individual fields before visiting them.
    if (text.length > limit - chars - 2) throw new Error(reason);
    let escaped = 2;
    for (let i = 0; i < text.length; i++) {
      if ((i & 4095) === 0) { checkWork(budget); if (escaped > limit - chars) throw new Error(reason); }
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) escaped += 2;
      else if (code < 32) escaped += 6;
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { escaped += 2; i++; }
      else escaped += code >= 0xd800 && code <= 0xdfff ? 6 : 1;
    }
    add(escaped);
  }
  function visit(item: unknown, depth: number) {
    if (++budget.fields > FIELD_LIMIT) throw new Error('Context estimate exceeds 262144 JSON fields');
    if ((budget.fields & 255) === 0) checkWork(budget);
    if (depth > DEPTH_LIMIT) throw new Error('Context estimate exceeds JSON depth 64');
    if (typeof item === 'string') { string(item); return; }
    if (item === null || typeof item !== 'object') { add(typeof item === 'number' && Number.isFinite(item) ? Math.max(4, String(item).length) : 5); return; }
    if (path.has(item)) throw new Error('Context estimate contains cyclic JSON');
    const proto: unknown = Object.getPrototypeOf(item);
    if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) throw new Error('Context estimate requires plain JSON');
    const toJSON = Object.getOwnPropertyDescriptor(item, 'toJSON');
    if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) throw new Error('Context estimate cannot execute JSON hooks');
    path.add(item); add(2);
    if (Array.isArray(item)) {
      if (item.length > MESSAGE_LIMIT) throw new Error('Context estimate exceeds 16384 JSON array items');
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor && !('value' in descriptor)) throw new Error('Context estimate cannot execute JSON accessors');
        add(1); visit(descriptor?.value, depth + 1);
      }
    } else {
      for (const property in item) {
        if (!Object.prototype.hasOwnProperty.call(item, property)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, property);
        if (!descriptor || !('value' in descriptor)) throw new Error('Context estimate cannot execute JSON accessors');
        string(property); add(2); visit(descriptor.value, depth + 1);
      }
    }
    path.delete(item);
  }
  checkWork(budget); visit(value, 0); checkWork(budget);
  const text = JSON.stringify(value);
  checkWork(budget);
  if (text === undefined || text.length > limit) throw new Error(reason);
  return text;
}
// Non-security cache keys only: the exact JSON bytes and FNV provenance remain unchanged.
function digest(text: string, seed = 2166136261, budget = work()) {
  let hash = seed;
  for (let i = 0; i < text.length; i++) { if ((i & 4095) === 0) checkWork(budget); hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); }
  checkWork(budget); return hash >>> 0;
}
function key(value: unknown) { const budget = work(); return digest(serialize(value, budget), undefined, budget).toString(16); }
function prefixKeys(messages: readonly Message[]) {
  if (messages.length > MESSAGE_LIMIT) throw new Error('Context estimate exceeds 16384 messages');
  const keys = [2166136261]; let chars = 0; const budget = work();
  for (const message of messages) {
    const text = serialize(message, budget, CHARACTER_LIMIT - chars); chars += text.length;
    // Avoid allocating another full-size message merely to append a newline.
    keys.push(digest('\n', digest(text, keys.at(-1), budget), budget));
  }
  return keys;
}
function contextLimit(model: Model<string> | undefined) { return model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null; }
function modelKey(model: Model<string> | undefined, revision = '') {
  return model ? key([model.provider, model.id, model.api, model.baseUrl, model.contextWindow, model.maxTokens, model.compat, revision]) : 'unavailable';
}
function promptKey(agent: Agent, messages: readonly Message[] = []) { return key([agent.instructions, agent.tools.map((tool) => [tool.name, tool.description, tool.parameters]), agent.sections.map((section) => section.key), messages.filter((message) => message.role === 'system')]); }
function validUsage(usage: Usage) {
  if (!usage || typeof usage !== 'object') return false;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((field) => typeof usage[field as keyof Usage] === 'number' && Number.isFinite(usage[field as keyof Usage]) && Number(usage[field as keyof Usage]) >= 0);
}
/** Same cut eligibility as pinned Pi 1.3; only identifies whether a threshold can act. */
function canCompact(view: ContextView, keep: number) {
  const start = view.head ? 1 : 0; const candidates: number[] = [];
  let before: AssistantMessage | undefined;
  const previous: (AssistantMessage | undefined)[] = [];
  for (const messages of view.contributions) {
    previous.push(before);
    for (const message of messages) if (message.role === 'assistant') before = message;
  }
  const started = performance.now();
  for (let i = start; i < view.contributions.length; i++) {
    if (performance.now() - started > WORK_MS) throw new Error('Compaction eligibility exceeds work budget');
    const first = view.contributions[i][0];
    if (first?.role === 'assistant') { candidates.push(i); continue; }
    if (first?.role !== 'user') continue;
    const before = previous[i];
    const calls = new Set(before ? before.content.flatMap((block) => block.type === 'toolCall' ? [block.id] : []) : []);
    if (!calls.size) { candidates.push(i); continue; }
    let safe = true;
    outer: for (let j = i; j < view.contributions.length; j++) for (const [position, message] of view.contributions[j].entries()) {
      if (message.role === 'assistant' && (j > i || position > 0)) break outer;
      if (message.role === 'toolResult' && calls.has(message.toolCallId)) { safe = false; break outer; }
    }
    if (safe) candidates.push(i);
  }
  let kept = 0;
  for (let i = view.contributions.length - 1; i >= start; i--) {
    for (const message of view.contributions[i]) kept += estimateMessageTokens(message);
    if (kept >= keep) {
      const cut = candidates.find((candidate) => candidate >= i) ?? candidates.at(-1);
      return cut !== undefined && view.contributions.slice(start, cut).some((messages) => messages.length);
    }
  }
  return false;
}
function thresholds(view: ContextView, limit: number, policy: CompactionPolicy) {
  const valid = [policy.reserveTokens, policy.keepRecentTokens, policy.backgroundTokens].every((n) => Number.isFinite(n) && n >= 0);
  const blocking = valid && policy.enabled && limit - policy.reserveTokens > 0 ? limit - policy.reserveTokens : null;
  const background = blocking !== null && policy.backgroundTokens > 0 && blocking - policy.backgroundTokens > 0 ? blocking - policy.backgroundTokens : null;
  return { background, blocking, reserve: valid ? policy.reserveTokens : 0, enabled: !!policy.enabled, actionable: valid && policy.enabled && blocking !== null && canCompact(view, policy.keepRecentTokens) };
}
type RequestBasis = { head: number | null; prefix: number; configuration: string; prompt: string };
export const ContextRequestBasisDoc = defineDocFamily<{ basis: RequestBasis | null }, string>({ kind: 'arxd.context-request-basis', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ basis: null }) });
export type CapacityRuntime = { harness: Harness; models: Models; policy(model?: Model<string>): CompactionPolicy; modelRevision?(provider: string): string; modelSource?(provider: string, id: string): 'manual' | 'catalog' | 'model-configuration' };

/** Request-time capture is numeric provenance only. Reading the meter never renders sections or writes documents. */
export function contextAccountingExtension(runtime: CapacityRuntime) {
  return defineExtension({ name: 'arxd-context-accounting', hooks: [hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      try {
        const conversation = await runtime.harness.conversation(api.conversationId, context);
        if (!conversation) return;
        const agent = await conversation.agent(context);
        const model = agent.model && runtime.models.getModel(agent.model.provider, agent.model.modelId);
        const view = await conversation.context(context);
        const basis: RequestBasis = { head: view.head?.id ?? null, prefix: prefixKeys(messages).at(-1)!, configuration: modelKey(model, model && runtime.modelRevision?.(model.provider)), prompt: promptKey(agent, messages) };
        await runtime.harness.commit(async (tx) => { (await tx.doc(ContextRequestBasisDoc, api.conversationId, String(api.taskId), String(api.taskId))).basis = basis; }, context);
      } catch { /* Accounting cannot prevent generation; unavailable provenance uses a local estimate. */ }
    },
  })] });
}

/** Estimate each independently attributable part; system text and tool declarations are split by source. */
function contextParts(messages: readonly Message[]): ContextPart[] {
  const totals = new Map<ContextPart['key'], number>();
  const add = (key: ContextPart['key'], tokens: number) => { if (tokens > 0) totals.set(key, (totals.get(key) ?? 0) + tokens); };
  const started = performance.now();
  for (const message of messages) {
    if (performance.now() - started > WORK_MS) throw new Error('Context breakdown exceeds 150 ms work budget');
    if (message.role === 'system') {
      add('system', estimateTextTokens(typeof message.content === 'string' ? message.content : ''));
      for (const [key, text] of Object.entries(message.sections ?? {})) if (text !== null) add(key === 'arxd_skills' ? 'skills' : 'system', estimateTextTokens(text));
      for (const tool of message.toolsAdded ?? []) add(tool.name.startsWith('mcp_') ? 'mcp' : tool.name.startsWith('skill_') ? 'skills' : 'tools', estimateTextTokens(JSON.stringify(tool)));
      for (const tool of message.toolsRemoved ?? []) add('tools', estimateTextTokens(tool.name));
    } else if (message.role === 'user') add('user', estimateMessageTokens(message));
    else if (message.role === 'assistant') add('assistant', estimateMessageTokens(message));
    else if (message.role === 'toolResult') add('toolResult', estimateMessageTokens(message));
  }
  return (['system', 'skills', 'mcp', 'tools', 'user', 'assistant', 'toolResult'] as const).flatMap((key) => {
    const tokens = totals.get(key) ?? 0;
    return tokens > 0 ? [{ key, tokens }] : [];
  });
}

async function project(runtime: CapacityRuntime, conversation: Conversation, agent: Agent, model: Model<string> | undefined, configuration: string, context: Context): Promise<ContextCapacity> {
  const view = await conversation.context(context);
  if (context.abortSignal?.aborted) throw new Error('Context estimate canceled');
  const result = unknownCapacity(String(conversation.id));
  const inbox = await runtime.harness.snapshot(InboxDoc, conversation.id, context);
  result.summaryPending = !!inbox?.items.some((item) => item.mode === 'write' && item.entry.kind === 'pi.compaction');
  result.model = agent.model ? { provider: agent.model.provider, id: agent.model.modelId, revision: configuration, limitSource: runtime.modelSource?.(agent.model.provider, agent.model.modelId) ?? 'model-configuration' } : null;
  result.limit = contextLimit(model);
  if (!result.limit) { result.reason = 'Model context window is unavailable or invalid'; return result; }
  if (!view.messages.length) { result.reason = 'No prepared committed context yet'; return result; }
  const prefixes = prefixKeys(view.messages);
  result.revision = `${view.head?.id ?? 'start'}:${view.entries.at(-1)?.id ?? 'empty'}:${prefixes.at(-1)}`;
  result.head = view.head?.id ?? null;
  result.thresholds = thresholds(view, result.limit, runtime.policy(model));
  const anchorDiagnostics = { checked: 0, selected: false } as NonNullable<ContextCapacity['anchorDiagnostics']>;
  result.anchorDiagnostics = anchorDiagnostics;
  let anchor: AssistantMessage | undefined; let index = -1; let lookups = 0;
  const currentPrompt = promptKey(agent, view.messages);
  result.configurationRevision = `${configuration}/${currentPrompt}`;
  for (let i = view.entries.length - 1; i >= 0 && lookups < 16; i--) {
    const entry = view.entries[i];
    if (view.head && entry.id <= view.head.id) continue;
    for (const message of [...view.contributions[i]].reverse()) {
      if (message.role !== 'assistant' || message.provider !== agent.model?.provider || message.model !== agent.model.modelId || !validUsage(message.usage) || calculateContextTokens(message.usage) <= 0 || !entry.byTaskId) continue;
      lookups++;
      const saved = await runtime.harness.snapshot(ContextRequestBasisDoc, conversation.id, String(entry.byTaskId), context);
      const position = view.messages.indexOf(message);
      const match = { saved: !!saved?.basis, position, head: !!saved?.basis && saved.basis.head === result.head, configuration: saved?.basis?.configuration === configuration, prompt: saved?.basis?.prompt === currentPrompt, prefix: position >= 0 && saved?.basis?.prefix === prefixes[position] };
      anchorDiagnostics.checked++; anchorDiagnostics.last = match;
      if (match.saved && match.head && match.configuration && match.prompt && match.position >= 0 && match.prefix) { anchor = message; index = position; anchorDiagnostics.selected = true; break; }
    }
    if (anchor) break;
  }
  let trailing = 0; const started = performance.now();
  for (const message of view.messages.slice(index + 1)) {
    trailing += estimateMessageTokens(message);
    if (!Number.isFinite(trailing) || trailing < 0 || performance.now() - started > WORK_MS) throw new Error('Context token estimate exceeded its work budget');
  }
  const usage = anchor ? calculateContextTokens(anchor.usage) : 0;
  const tokens = Math.ceil(usage + trailing);
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid context token estimate');
  const parts = contextParts(view.messages);
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (tokens > estimated) parts.push({ key: 'other', tokens: tokens - estimated });
  return { ...result, state: 'current', reason: null, tokens, parts, source: anchor ? 'provider-anchored-estimate' : 'estimate', usageTokens: usage, trailingTokens: trailing,
    ratio: tokens / result.limit, remaining: Math.max(0, result.limit - tokens), emphasis: tokens > result.limit ? 'over-limit' : result.thresholds.actionable && result.thresholds.blocking !== null && tokens > result.thresholds.blocking ? 'blocking' : result.thresholds.actionable && result.thresholds.background !== null && tokens > result.thresholds.background ? 'background' : 'normal' };
}

/** One coalesced read, 250ms minimum interval, eight cached conversations; streaming documents are ignored. */
export function createCapacityProjection(runtime: CapacityRuntime, changed: () => void) {
  const revisions = new Map<ConversationId, number>();
  const cache = new Map<string, ContextCapacity>();
  let latest: { conversation: Conversation; agent: Agent; model?: Model<string>; configuration: string; key: string } | undefined;
  let cancelCurrent: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined; let closed = false; let running = false; let last = 0;
  async function update() {
    timer = undefined; if (closed || running || !latest) return;
    const input = latest; running = true; last = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const reading = withCancel(BACKGROUND_CONTEXT); cancelCurrent = reading.cancel;
    let timedOut = false, retry = false;
    try {
      const value = await Promise.race([project(runtime, input.conversation, input.agent, input.model, input.configuration, reading.context), new Promise<never>((_, reject) => { timeout = setTimeout(() => { timedOut = true; reading.cancel(); reject(new Error('Context read exceeded 500 ms; estimate pending retry')); }, READ_MS); })]);
      if (!closed && latest?.key === input.key) { cache.set(input.key, value); changed(); }
    } catch (failure) {
      if (!closed && reading.context.abortSignal?.aborted && !timedOut) retry = true;
      else if (!closed && latest?.key === input.key) {
        const previous = cache.get(input.key) ?? unknownCapacity(String(input.conversation.id));
        cache.set(input.key, { ...previous, state: previous.tokens === null ? 'unavailable' : 'stale', reason: String(failure).slice(0, 240), limit: contextLimit(input.model) }); changed();
      }
    } finally { clearTimeout(timeout); reading.cancel(); cancelCurrent = undefined; running = false; if (!closed && (retry || latest?.key !== input.key)) schedule(); }
  }
  function schedule() { if (!closed && !timer && !running) timer = setTimeout(() => { void update(); }, Math.max(0, 250 - (Date.now() - last))); }
  return {
    observe(publication: CommitPublication) {
      const dirty = new Set<ConversationId>();
      for (const change of publication.changes) {
        if (change.type === 'entry') dirty.add(change.value.conversationId);
        else if (change.type === 'document' && ['pi.agent', 'pi.inbox'].includes(change.record.kind) && change.conversationId !== undefined) dirty.add(change.conversationId);
      }
      for (const id of dirty) revisions.set(id, (revisions.get(id) ?? 0) + 1);
    },
    read(conversation: Conversation | undefined, agent: Agent | undefined): ContextCapacity {
      if (!conversation || !agent) { cancelCurrent?.(); latest = undefined; return unknownCapacity(); }
      try {
        const model = agent.model && runtime.models.getModel(agent.model.provider, agent.model.modelId);
        let configuration: string;
        try { configuration = modelKey(model, model && runtime.modelRevision?.(model.provider)); } catch { return { ...unknownCapacity(String(conversation.id)), reason: 'Invalid model configuration' }; }
        const id = `${conversation.id}/${configuration}/${promptKey(agent)}/${key(runtime.policy())}/${revisions.get(conversation.id) ?? 0}`;
        if (running && latest?.key !== id) cancelCurrent?.();
        latest = { conversation, agent, model, configuration, key: id };
        const found = cache.get(id); if (found) return found;
        if (cache.size >= 8) cache.delete(cache.keys().next().value!);
        const previous = [...cache.values()].findLast((value) => value.conversationId === String(conversation.id) && value.model?.revision === configuration && value.tokens !== null);
        const pending = { ...(previous ?? unknownCapacity(String(conversation.id))), state: previous ? 'stale' as const : 'pending' as const, reason: 'Reading committed context', model: agent.model ? { provider: agent.model.provider, id: agent.model.modelId, revision: configuration, limitSource: runtime.modelSource?.(agent.model.provider, agent.model.modelId) ?? 'model-configuration' as const } : null, limit: contextLimit(model) };
        cache.set(id, pending); schedule(); return pending;
      } catch (failure) { return { ...unknownCapacity(String(conversation.id)), reason: String(failure).slice(0, 240) }; }
    },
    close() { closed = true; clearTimeout(timer); cancelCurrent?.(); cache.clear(); latest = undefined; },
  };
}
