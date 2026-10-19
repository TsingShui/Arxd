import { isLocalModelId, LOCAL_PROVIDER_ID, localProviderRevision } from '../agent/local-provider.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, type AssistantMessage, type ModelThinkingLevel, type ToolCall, type ToolResultMessage, type UserMessage } from '@earendil-works/pi-ai';
import { AssistantEntry, LiveDoc, InboxDoc, defineDoc, defineExtension, defineTool, ToolResultEntry, UserEntry, type Conversation, type ConversationId, type Cursor, type EntryId, type JsonObject, type TaskId } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { FileRoot, WorkspaceFile } from '../../modules/rxd/index.ts';
import { MAX_IMPORT_BYTES, MAX_MESSAGE_CHARS, MIN_IMPORT_BYTES } from './limits.ts';
import type { RequestFailure, RetryMessage } from '../agent/request-retry.ts';
import { RequestRecordsDoc, type RequestRecord } from './request-records.ts';
import { arxdInstructions } from '../agent/instructions.ts';
import { tr } from '../i18n/base.ts';
import { openAgentRuntime, type RxdHost } from '../agent/runtime.ts';
import { createTimingTracker, TimingDoc, type ActivePhase, type TurnTiming } from './activity.ts';
import { openWorkspaceController, type WorkspaceController } from './lifecycle.ts';
import { pendingDeletions, requireAvailable, deletingIds, type PendingDeletion } from './deletions.ts';
import { FileLibrary } from './files.ts';
import { SkillLibrary } from './skills.ts';
import { McpLibrary } from './services-library.ts';
import { serviceExtension } from './service-tools.ts';
import { AdmittedSkillsDoc, skillExtension } from './skill-tools.ts';
import { createCapacityProjection, contextAccountingExtension, unknownCapacity, type ContextCapacity, type CapacityRuntime } from './context-capacity.ts';
import { type Connection, type ConnectionLibrary, type ConnectionSecret, type Generation, type ModelChoice, type manualModel } from './connections.ts';

/// A stored limit is only honoured when it is a usable byte count inside the app ceiling;
/// anything else falls back to the ceiling instead of silently shrinking imports.
const importLimitOf = (preferences: Readonly<Preferences> | undefined) => {
  const value = preferences?.importLimit;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_IMPORT_BYTES && value <= MAX_IMPORT_BYTES ? value : MAX_IMPORT_BYTES;
};

const xmlAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const localFilePath = (uri: string) => {
  const path = uri.startsWith('file://') ? uri.slice(7) : uri;
  try { return decodeURIComponent(path); } catch { return path; }
};

export type Palette = 'fire' | 'spring';
export type AppearanceMode = 'system' | 'light' | 'dark';
export type MotionMode = 'system' | 'reduced';
export type ModelMode = string;
type Preferences = { model?: ModelMode; testModelMigrated?: boolean; palette: Palette; appearance?: AppearanceMode; motion?: MotionMode; importLimit?: number; thinking?: ModelThinkingLevel; thinkingByModel?: Record<string, ModelThinkingLevel>; active: ConversationId | null; conversations: ConversationId[] };
type ConversationBranch = { thread: string; index: number; parent?: string; hiddenTurns?: string[] };
type ConversationMeta = { model?: ModelMode; title: string; updatedAt: number; files: WorkspaceFile[]; archived?: boolean; selectedSkills?: string[]; branch?: ConversationBranch };
const PreferencesDoc = defineDoc<Preferences>({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ palette: 'fire', appearance: 'system', motion: 'system', deletions: [], active: null, conversations: [] }) });
const MetadataDoc = defineDoc<ConversationMeta>({ kind: 'arxd.conversation', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ title: tr('新对话'), updatedAt: 0, files: [] }) });

export type ToolView = { id: string; name: string; text: string; details: unknown; isError: boolean; records: JsonObject[]; durationMs?: number; arguments?: ToolCall['arguments'] };
export type ActivityBlock = { kind: 'request-error'; id: string; failure: RequestFailure; partial: boolean } | { kind: 'text'; id: string; text: string } |
  { kind: 'thinking'; id: string; text: string; timingKey: string; live: boolean } |
  { kind: 'tool'; id: string; name: string; callId: string; arguments: ToolCall['arguments']; timingKey: string; state: 'pending' | 'running' | 'done' | 'error' | 'stopped'; result?: ToolView; output?: string };
export type TurnView = { requestErrors?: RequestFailure[]; recovery?: { attempt: number; at: number; error: string }; tokens: number; cost: number; provider?: string; modelId?: string; modelLabel: string; id: string; prompt: string; file: WorkspaceFile | null; answer: string; calls: { id: string; name: string }[]; tools: ToolView[]; activities: ActivityBlock[]; startedAt: number; endedAt?: number; timing?: TurnTiming; phase?: 'waiting' | 'thinking' | 'answer' | 'tool' | 'preparing' | 'recovery'; status: 'running' | 'done' | 'failed' | 'stopped' };
export type ConversationSummary = { id: ConversationId; title: string; updatedAt: number; busy: boolean; archived: boolean; thread: string; branchIndex: number };
export type BranchInfo = { thread: string; index: number; count: number; versions: { id: ConversationId; index: number; active: boolean }[] };
export type SearchHit = { kind: 'message' | 'file'; text: string };
export type SearchGroup = { id: ConversationId; title: string; titleMatch: boolean; archived: boolean; hits: SearchHit[] };
export type SearchScope = 'active' | 'archived' | 'all';
export type Artifact = { id: string; name: string; content: string; mime: string; turnId: string };
export type WorkspaceSnapshot = {
  model: ModelMode; modelLabel: string; thinking: ModelThinkingLevel; palette: Palette; active: ConversationId | null; conversations: ConversationSummary[];
  title: string; files: WorkspaceFile[]; turns: TurnView[];
  busy: boolean; hasMoreHistory: boolean; error: string | null;
  compactions: { id: string; blocking: boolean; attempt: number; retryAt?: number }[]; compactionError: string | null;
  capacity: ContextCapacity;
  branch?: BranchInfo;
  requestRecords?: RequestRecord[];
  selectedSkills: { id: string; name: string; available: boolean }[];
  models: ModelChoice[];
  appearance: AppearanceMode; motion: MotionMode; importLimit: number; deletions: PendingDeletion[];
};

const initial: WorkspaceSnapshot = { capacity: unknownCapacity(), model: '', modelLabel: tr('未配置模型'), thinking: 'off', palette: 'fire', appearance: 'system', motion: 'system', importLimit: MAX_IMPORT_BYTES, deletions: [], active: null, conversations: [], title: tr('新对话'), files: [], turns: [], busy: false, hasMoreHistory: false, error: null, compactions: [], compactionError: null, selectedSkills: [], models: [] };
const textOf = (content: UserMessage['content'] | AssistantMessage['content'] | ToolResultMessage['content']) => typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

function appendActivity(turn: TurnView, message: AssistantMessage, request: string, live: boolean) {
  for (const [index, block] of message.content.entries()) {
    const id = `${request}/${index}`;
    if (block.type === 'text') turn.activities.push({ kind: 'text', id, text: block.text });
    else if (block.type === 'thinking') turn.activities.push({ kind: 'thinking', id, timingKey: id, text: block.redacted ? '' : block.thinking, live: live && index === message.content.length - 1 });
    else if (block.type === 'toolCall') turn.activities.push({ kind: 'tool', id, timingKey: id, callId: block.id, name: block.name, arguments: block.arguments, state: 'pending' });
  }
  const failure = (message as RetryMessage).arxdFailure;
  if (failure) turn.activities.push({ kind: 'request-error', id: `${request}/error`, failure, partial: message.content.length > 0 });
}

export function parseRecords(text: string): JsonObject[] {
  return text.trim().split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value as JsonObject] : []; }
    catch { return []; }
  });
}

/** Reports exist only when a user opens or saves one; snapshots and browsing never build them. */
function reportOf(turn: TurnView, title: string, modelLabel: string): Artifact {
  const heading = title || tr('Arxd 分析记录');
  const content = `${tr('# {title}', { title: heading })}\n\n> ${tr('{model}；下列输出来自真实本地工具。', { model: modelLabel })}\n\n${tr('## 问题')}\n\n${turn.prompt}\n\n${tr('## 输入')}\n\n${turn.file ? `${turn.file.name}\nSHA-256: ${turn.file.sha256}` : tr('当前对话上下文')}\n\n${tr('## 回复')}\n\n${turn.answer || tr('本次执行已停止或中断。')}\n\n${tr('## 工具记录')}\n\n${turn.tools.map((tool) => `${tr('### {name}', { name: tool.name })}\n\n${tr('状态：{status}', { status: tool.isError ? tr('失败或中断') : tr('完成') })}\n\n\`\`\`text\n${tool.text}\n\`\`\``).join('\n\n')}\n`;
  return { id: `report-${turn.id}`, name: `report-${turn.id}.md`, content, mime: 'text/markdown', turnId: turn.id };
}

export function openWorkspace(database: SqliteDatabase, host: RxdHost): Promise<WorkspaceController> { return openWorkspaceController(database, host); }

export async function openWorkspaceSession(database: SqliteDatabase, host: RxdHost, beforeResume: (harness: Awaited<ReturnType<typeof openAgentRuntime>>['harness']) => Promise<void>) {
  const { harness, registry, connections, models, getCompactionPolicy } = await openAgentRuntime(database, host);
  // Remove the old offline test model from the product default. Keep the faux
  // provider internal for deterministic verification and legacy test histories.
  const productDefault = connections.choices()[0]?.id;
  if (productDefault) {
    const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
    if (preferences?.model === 'test' && !preferences.testModelMigrated) {
      await harness.commit(async (tx) => { const prefs = await tx.doc(PreferencesDoc); prefs.model = productDefault; prefs.testModelMigrated = true; }, BACKGROUND_CONTEXT);
      if (preferences.active) {
        const activeMeta = await harness.snapshot(MetadataDoc, preferences.active, BACKGROUND_CONTEXT);
        if (activeMeta?.model === 'test') await harness.commit(async (tx) => { (await tx.doc(MetadataDoc, preferences.active!)).model = productDefault; }, BACKGROUND_CONTEXT);
      }
    }
  }
  const labelFor = (mode?: ModelMode) => mode ? tr(connections.label(mode)) : tr('未配置模型');
  const firstMode = () => connections.choices()[0]?.id;
  const thinkingLevels = (mode?: ModelMode) => mode ? connections.choices().find((model) => model.id === mode)?.thinking ?? ['off'] as ModelThinkingLevel[] : ['off'] as ModelThinkingLevel[];
  // Explicit choices are remembered per model. A model never inherits another
  // model's level; only its own cached value (or the legacy single preference
  // recorded for that same model) seeds it, otherwise Pi's first level applies.
  const rememberedThinking = (preferences: Readonly<Preferences> | undefined, mode?: ModelMode): ModelThinkingLevel => {
    const levels = thinkingLevels(mode);
    const remembered = mode ? preferences?.thinkingByModel?.[mode] : undefined;
    const legacy = mode && preferences?.model === mode ? preferences?.thinking : undefined;
    return remembered && levels.includes(remembered) ? remembered : legacy && levels.includes(legacy) ? legacy : levels[0];
  };
  const modelTools = (mode?: string) => registry.snapshot().tools().filter(({ tool }) => (!isLocalModelId(mode) || ['rxd_file_outline', 'shell'].includes(tool.name)) && (tool.callers ?? ['model', 'tools']).includes('model') && tool.deferred !== true && !(tool.name.startsWith('mcp_') && !tool.name.startsWith('mcp__'))).map(({ tool }) => tool);
  const localExtensions = () => registry.snapshot().installed().filter((extension) => ['arxd-runtime', 'arxd-workspace', 'arxd-context-accounting'].includes(extension.name));
  const library = new FileLibrary(database);
  const skills = new SkillLibrary(database, host.skills);
  const mcp = host.services ? new McpLibrary(database, host.services, registry, host.mcpConfig) : undefined;
  try {
    await library.open();
    await skills.open();
    await mcp?.open();
    void mcp?.startup();
    const migration = await library.migration();
    if (!migration.done) {
      let cursor = migration.cursor;
      do {
        const page = await harness.commit((tx) => tx.scanConversations({ order: 'ascending' }, 64, cursor), BACKGROUND_CONTEXT);
        for (const record of page.items) {
          const meta = await harness.snapshot(MetadataDoc, record.id, BACKGROUND_CONTEXT);
          for (const file of meta?.files ?? []) await library.register(file, 'import', undefined, true);
        }
        cursor = page.next;
        await library.migrated(cursor);
      } while (cursor);
    }
    await library.resume(host.files);
    await skills.resume();
  } catch (error) { await harness.close(BACKGROUND_CONTEXT); throw error; }
  if (host.skills) registry.install(skillExtension(skills, models));
  if (host.services && mcp) registry.install(serviceExtension(host.services, mcp));
  const timing = createTimingTracker(harness);
  const tracked = new Set<ConversationId>();
  registry.install(defineExtension({
    name: 'arxd-workspace',
    tools: [defineTool({
      name: 'rxd_file_outline', description: 'Query the captured UTF-8 JavaScript input with the installed local rxd. Never execute the input.',
      parameters: Type.Object({ fileId: Type.String({ pattern: '^[a-f0-9-]+$' }), inputSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), engineSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }),
      replay: 'safe', outputLimits: { maxBytes: 32768, maxLines: 128, retain: 'head' },
      execute: async (input, api, context) => {
        const metadata = await api.snapshot(MetadataDoc, api.conversationId, context);
        const owned = metadata?.files.some((file) => file.id === input.fileId);
        const captured = owned ? await library.get(input.fileId) : undefined;
        const file = captured?.status === 'active' ? captured.file : undefined;
        if (!file || file.source === null || file.sha256 !== input.inputSha256) throw new Error('Imported source capture is unavailable or changed');
        if (context.abortSignal?.aborted) throw new Error('Analysis cancelled');
        const result = await host.run({ source: file.source, inputSha256: input.inputSha256, engineSha256: input.engineSha256 });
        if (result.inputSha256 !== file.sha256 || result.engineSha256 !== input.engineSha256) throw new Error('Analysis identity mismatch');
        return { isError: result.exitCode !== 0, output: [{ type: 'text', text: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout }],
          details: { ...result, fileId: file.id, fileName: file.name, recordCount: parseRecords(result.stdout).length } };
      },
    })],
  }));

  const capacityRuntime: CapacityRuntime = {
    harness, models, policy: (model) => getCompactionPolicy(model?.contextWindow),
    modelRevision: (provider) => {
      if (provider === 'faux') return 'offline';
      if (provider === LOCAL_PROVIDER_ID) return localProviderRevision(host.localModel?.status().models ?? []);
      try { return String(connections.get(provider).revision); } catch { return 'unavailable'; }
    },
    modelSource: (provider, id) => connections.configured(provider).find((entry) => entry.definition.id === id)?.source ?? 'model-configuration',
  };
  registry.install(contextAccountingExtension(capacityRuntime));
  const capacity = createCapacityProjection(capacityRuntime, () => { if (!closed) void refresh().catch(() => undefined); });
  let cached = initial;
  let active = (await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT))?.active ?? null;
  let entryLimit = 128;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  let closed = false;
  let fileTail: Promise<unknown> = Promise.resolve();
  let branching = false;
  function fileChange<T>(action: () => Promise<T>): Promise<T> {
    const next = fileTail.then(() => { if (closed) throw new Error('Workspace is closed'); return action(); });
    fileTail = next.catch(() => undefined);
    return next;
  }
  function requireIdle() { if (cached.conversations.some((conversation) => conversation.busy)) throw new Error(tr('请先停止正在运行的任务')); }
  function requireConversationIdle(id: ConversationId | null) { if (id !== null && cached.conversations.some((conversation) => conversation.busy && conversation.id === id)) throw new Error(tr('请先停止正在运行的任务')); }
  async function skillIdle() {
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    return !inspection.submissions.length && !inspection.tasks.some((task) => task.record.kind !== 'pi.compaction');
  }
  async function requireSkillIdle() { if (!await skillIdle()) throw new Error(tr('请先停止正在运行的任务')); }
  async function requireModelIdle() { const state = await harness.inspect(BACKGROUND_CONTEXT); if (state.tasks.length || state.submissions.length) throw new Error(tr('请先停止正在运行的任务')); }
  async function resolvedMetadata(meta: Readonly<ConversationMeta> | undefined) {
    if (!meta) return meta;
    return { ...meta, files: await Promise.all(meta.files.map(async (file) => {
      const record = await library.get(file.id);
      return record?.status === 'active' ? record.file : { ...file, name: record?.file.name ?? file.name, source: null, available: false };
    })) };
  }

  async function readTurns(conversation: Conversation, metadata: Readonly<ConversationMeta> | undefined, limit: number) {
    const page = await conversation.entries({ order: 'descending' }, limit, undefined, BACKGROUND_CONTEXT);
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    const busy = !!live?.run;
    const turns: TurnView[] = [];
    const lastModelTasks = new Map<TurnView, { id: TaskId; conversationId: ConversationId }>();
    for (const entry of (page?.items ?? []).slice().reverse()) {
      if (UserEntry.is(entry)) {
        if (metadata?.branch?.hiddenTurns?.includes(String(entry.id))) continue;
        const message = entry.model?.find((m): m is UserMessage => m.role === 'user');
        if (!message) continue;
        const text = textOf(message.content);
        const fileId = /<arxd-file id="([a-f0-9-]+)"/.exec(text)?.[1];
        turns.push({ activities: [], startedAt: message.timestamp, tokens: 0, cost: 0, modelLabel: labelFor(metadata?.model), id: String(entry.id), prompt: text.split('\n\n<arxd-workspace>')[0], file: metadata?.files.find((f) => f.id === fileId) ?? null, answer: '', calls: [], tools: [], status: 'stopped' });
      } else if (AssistantEntry.is(entry)) {
        const turn = turns.at(-1); if (!turn) continue;
        for (const message of entry.model ?? []) {
          if (message.role !== 'assistant') continue;
          if (entry.byTaskId !== undefined) lastModelTasks.set(turn, { id: entry.byTaskId, conversationId: entry.conversationId });
          if ((message as RetryMessage).arxdFailure) (turn.requestErrors ??= []).push((message as RetryMessage).arxdFailure!);
          appendActivity(turn, message, `${entry.byTaskId ?? entry.id}/${message.timestamp}`, false);
          turn.tokens += message.usage.totalTokens; turn.cost += message.usage.cost.total; turn.provider = message.provider; turn.modelId = message.model;
          turn.modelLabel = tr(connections.responseLabel(message.provider, message.model));
          turn.calls.push(...message.content.filter((p) => p.type === 'toolCall').map((p) => ({ id: p.id, name: p.name })));
          if (['stop', 'error', 'aborted', 'length'].includes(message.stopReason)) {
            if (message.durationMs !== undefined) turn.endedAt = message.timestamp + message.durationMs;
            turn.answer = textOf(message.content);
            if (!turn.answer && !((message as RetryMessage).arxdFailure) && message.errorMessage) turn.answer = message.errorMessage;
            turn.status = message.stopReason === 'aborted' ? 'stopped' : message.stopReason === 'error' || message.stopReason === 'length' || turn.tools.at(-1)?.isError ? 'failed' : 'done';
          }
        }
      } else if (ToolResultEntry.is(entry)) {
        const turn = turns.at(-1); if (!turn) continue;
        for (const message of entry.model ?? []) if (message.role === 'toolResult') {
          const text = textOf(message.content);
          const tool: ToolView = { id: message.toolCallId, name: message.toolName, text, details: message.details, isError: !!message.isError,
            ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
            records: message.toolName.startsWith('rxd_') && !message.isError ? parseRecords(text) : [] };
          turn.tools.push(tool);
          const block = turn.activities.findLast((block) => block.kind === 'tool' && block.callId === message.toolCallId && !block.result);
          if (block?.kind === 'tool') {
            block.timingKey = `tool:${entry.byTaskId ?? block.id}`;
            block.result = tool; tool.arguments = block.arguments;
            const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
            block.state = !tool.isError ? 'done' : diagnostics.some((item) => /abort|interrupt/.test(item.code ?? '')) ? 'stopped' : 'error';
          }
        }
      }
    }
    const last = turns.at(-1);
    // Canceling a backoff need not append a new assistant message. Its earlier
    // network error stays visible, while the exact owning generation's durable
    // aborted outcome decides the turn status (also after a fresh process).
    const failed = turns.filter((turn) => turn.status === 'failed' && (turn !== last || !busy)).flatMap((turn) => {
      const owner = lastModelTasks.get(turn);
      return owner ? [{ turn, owner }] : [];
    });
    if (failed.length) {
      const tasks = await harness.commit((tx) => Promise.all(failed.map(({ owner }) => tx.task(owner.id))), BACKGROUND_CONTEXT);
      for (const [index, task] of tasks.entries()) {
        const { turn, owner } = failed[index];
        if (task?.kind === 'pi.generation' && task.conversationId === owner.conversationId && (task.state.status === 'terminal' || task.state.status === 'completing') && task.state.outcome.status === 'aborted') {
          turn.status = 'stopped';
          turn.endedAt = task.endedAt ?? turn.endedAt;
        }
      }
    }
    const phases: ActivePhase[] = [];
    if (busy && last) {
      last.status = 'running';
      const partial = live?.generation?.message;
      if (partial) {
        last.answer = textOf(partial.content);
        appendActivity(last, partial, `${live!.run!.taskId}/${partial.timestamp}`, partial.timestamp >= timing.openedAt);
      }
      for (const slot of live?.tools ?? []) {
        const block = last.activities.findLast((block) => block.kind === 'tool' && block.callId === slot.callId);
        if (block?.kind !== 'tool' || block.result) continue;
        block.timingKey = `tool:${slot.taskId ?? block.id}`;
        block.state = slot.status === 'running' ? 'running' : 'pending';
        if (slot.output) block.output = slot.output;
        const preview = slot.details as { stdoutTail?: string; stderrTail?: string } | undefined;
        if (preview?.stdoutTail || preview?.stderrTail) block.output = [preview.stdoutTail, preview.stderrTail ? `stderr:\n${preview.stderrTail}` : ''].filter(Boolean).join('\n');
        if (slot.status === 'running') phases.push({ key: block.timingKey, kind: 'tool' });
      }
      if (live?.generation?.retry) { last.phase = 'recovery'; last.recovery = { attempt: live.generation.attempt, ...live.generation.retry }; }
      else if (phases.length) last.phase = 'tool';
      else if (live?.generation) {
        const block = last.activities.at(-1);
        const source = partial && partial.timestamp >= timing.openedAt ? partial.content.at(-1) : undefined;
        if (source?.type === 'thinking' && block?.kind === 'thinking') {
          last.phase = 'thinking'; phases.push({ key: block.timingKey, kind: 'thinking', evidenceAt: partial!.timestamp });
        } else if (source?.type === 'text' && block?.kind === 'text') {
          last.phase = 'answer'; phases.push({ key: block.id, kind: 'answer', evidenceAt: partial!.timestamp });
        } else {
          last.phase = source?.type === 'toolCall' ? 'preparing' : 'waiting';
          phases.push({ key: `waiting:${live.run!.taskId}/${live.generation.attempt}`, kind: 'waiting' });
        }
      } else last.phase = last.activities.some((block) => block.kind === 'tool' && block.state === 'pending') ? 'preparing' : 'waiting';
    }
    if (!busy) for (const turn of turns) for (const block of turn.activities) if (block.kind === 'tool' && !block.result) block.state = 'stopped';
    for (const turn of turns) {
      if (turn !== last) {
        const stored = await harness.snapshot(TimingDoc, conversation.id, turn.id, BACKGROUND_CONTEXT);
        if (stored) turn.timing = stored;
        continue;
      }
      const completed = new Map<string, number | undefined>();
      for (const block of turn.activities) if (block.kind === 'tool' && block.result) completed.set(block.timingKey, block.result.durationMs);
      turn.timing = await timing.update(conversation.id, turn.id, turn.startedAt, busy ? phases : [], completed, busy ? undefined : turn.endedAt, !busy);
      if (!busy && turn.endedAt === undefined && turn.timing.endedAt !== undefined) turn.endedAt = turn.timing.endedAt;
    }
    return { page, turns, live, busy };
  }

  async function readSnapshot(): Promise<WorkspaceSnapshot> {
    const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const busyIds = new Set(inspection.tasks.filter((t) => t.record.kind !== 'pi.compaction' && !t.record.background).map((t) => t.record.conversationId));
    for (const submission of inspection.submissions) busyIds.add(submission.conversationId);
    const deletions = await pendingDeletions(database);
    const deleting = await deletingIds(database);
    if (active !== null && deleting.has(active)) active = null;
    const conversations: ConversationSummary[] = [];
    const metas: { id: ConversationId; meta: ConversationMeta }[] = [];
    for (const id of preferences?.conversations ?? []) {
      if (deleting.has(id)) continue;
      const meta = await harness.snapshot(MetadataDoc, id, BACKGROUND_CONTEXT);
      if (!meta) continue;
      metas.push({ id, meta });
      conversations.push({ id, title: meta.title, updatedAt: meta.updatedAt, busy: busyIds.has(id), archived: !!meta.archived, thread: meta.branch?.thread ?? String(id), branchIndex: meta.branch?.index ?? 0 });
    }
    // A branch is a version of one chat, not a separate history row: keep the
    // open version, otherwise the most recently touched sibling.
    const threads = new Map<string, ConversationSummary>();
    for (const row of conversations) {
      const current = threads.get(row.thread);
      if (!current || row.id === active || (current.id !== active && row.updatedAt > current.updatedAt)) threads.set(row.thread, row);
    }
    const conversationRows = [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const conversation = active === null ? undefined : await harness.conversation(active, BACKGROUND_CONTEXT);
    const metadata = conversation ? await resolvedMetadata(await harness.snapshot(MetadataDoc, conversation.id, BACKGROUND_CONTEXT)) : undefined;
    const projected = conversation ? await readTurns(conversation, metadata, entryLimit) : undefined;
    const turns = projected?.turns ?? [];
    const busy = projected?.busy ?? false;
    const live = projected?.live;
    for (const id of busyIds) tracked.add(id);
    if (active !== null) tracked.add(active);
    for (const id of tracked) {
      if (id === active) { if (!busy) tracked.delete(id); continue; }
      const other = await harness.conversation(id, BACKGROUND_CONTEXT);
      if (!other) { tracked.delete(id); continue; }
      const value = await readTurns(other, await resolvedMetadata(await harness.snapshot(MetadataDoc, id, BACKGROUND_CONTEXT)), 128);
      if (!value.busy) tracked.delete(id);
    }
    const model = metadata?.model ?? preferences?.model ?? firstMode() ?? '';
    const levels = thinkingLevels(model);
    const resolvedAgent = conversation ? await conversation.agent(BACKGROUND_CONTEXT) : undefined;
    const remembered = rememberedThinking(preferences, model);
    // The open conversation's configured level is the effective one; the stored
    // preference only seeds it when that level no longer exists or restart lost it.
    const stored: ModelThinkingLevel = resolvedAgent?.thinkingLevel ?? remembered;
    // A level stored for another model is not valid here, so the snapshot only ever
    // reports a level the active model can honour; the preferences themselves are kept.
    const level = levels.includes(stored) ? stored : remembered;
    const selectedSkills = await Promise.all((metadata?.selectedSkills ?? []).map(async (id) => {
      const value = await skills.get(id);
      return { id, name: value?.name ?? tr('技能不可用'), available: !!value?.enabled && value.status === 'active' };
    }));
    const requestRecords = conversation ? (await harness.snapshot(RequestRecordsDoc, conversation.id, BACKGROUND_CONTEXT))?.records.slice() ?? [] : [];
    const activeMeta = active === null ? undefined : metas.find((row) => row.id === active)?.meta;
    const thread = active === null ? undefined : activeMeta?.branch?.thread ?? String(active);
    const versions = thread === undefined ? [] : metas
      .filter((row) => (row.meta.branch?.thread ?? String(row.id)) === thread)
      .sort((a, b) => (a.meta.branch?.index ?? 0) - (b.meta.branch?.index ?? 0) || a.meta.updatedAt - b.meta.updatedAt)
      .map((row, position) => ({ id: row.id, index: position + 1, active: row.id === active }));
    const branch = thread !== undefined && versions.length > 1 ? { thread, index: versions.findIndex((version) => version.active) + 1, count: versions.length, versions } : undefined;
    if ((conversation?.id ?? null) !== active) return cached;
    cached = { deletions, appearance: preferences?.appearance ?? (preferences ? preferences.palette === 'spring' ? 'light' : 'dark' : 'system'), motion: preferences?.motion ?? 'system', importLimit: importLimitOf(preferences), models: connections.choices(), requestRecords, capacity: capacity.read(conversation, resolvedAgent), model, modelLabel: labelFor(model), thinking: level, palette: preferences?.palette ?? 'fire', active, conversations: conversationRows, ...(branch ? { branch } : {}), title: metadata?.title ?? tr('新对话'), files: metadata?.files.slice() ?? [],
      turns, busy, selectedSkills, hasMoreHistory: !!projected?.page.next, error: null, compactions: (live?.compactions ?? []).map((item) => ({ id: String(item.taskId), blocking: item.blocking, attempt: item.attempt, ...(item.retry ? { retryAt: item.retry.at } : {}) })), compactionError: live?.compactionFailure?.error ?? null };
    for (const listener of listeners) listener(cached);
    return cached;
  }
  function refresh() {
    const next = refreshTail.then(readSnapshot);
    refreshTail = next.catch((error) => {
      cached = { ...cached, error: String(error) };
      for (const listener of listeners) listener(cached);
    });
    return next;
  }
  function schedule() {
    if (refreshTimer || closed) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(() => undefined); }, 45);
  }
  const unsubscribe = harness.subscribeCommits((publication) => { capacity.observe(publication); schedule(); });
  async function conversation() {
    if (active !== null) {
      await requireAvailable(database, active);
      const found = await harness.conversation(active, BACKGROUND_CONTEXT); if (found) return found;
    }
    const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
    const mode = preferences?.model ?? firstMode() ?? '';
    if (!mode) throw new Error(tr('请先配置模型'));
    const created = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: {
      model: connections.resolve(mode).ref,
      thinkingLevel: rememberedThinking(preferences, mode), instructions: mode !== 'test' ? arxdInstructions(isLocalModelId(mode)) : undefined,
      extensions: isLocalModelId(mode) ? localExtensions() : undefined,
      modelTools: modelTools(mode),
    },
      init: async (tx, id) => { const meta = await tx.doc(MetadataDoc, id); meta.model = mode; meta.updatedAt = Date.now(); const prefs = await tx.doc(PreferencesDoc); prefs.active = id; prefs.conversations.push(id); },
    }, BACKGROUND_CONTEXT);
    active = created.id;
    return created;
  }
  try { await beforeResume(harness); harness.resume(); await refresh(); }
  catch (error) { closed = true; unsubscribe(); await harness.close(BACKGROUND_CONTEXT); throw error; }

  async function attachFile(file: WorkspaceFile) {
    // Only this conversation's own run blocks an attachment: other conversations may be
    // running concurrently, and the library write is serialized by fileChange.
    requireConversationIdle(active);
    const saved = await library.register(file);
    const current = await conversation();
    await current.commit(async (tx) => {
      const meta = await tx.doc(MetadataDoc, current.id);
      if (!meta.files.some((file) => file.id === saved.id)) meta.files.push(saved);
      if (meta.title === tr('新对话')) meta.title = saved.name;
      meta.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    return refresh();
  }

  let skillRefreshQueued = false;
  const unwatchSkills = host.skills?.watch?.(() => {
    if (closed || skillRefreshQueued) return;
    skillRefreshQueued = true;
    void fileChange(async () => {
      try { await skills.refreshAll(await skillIdle()); await refresh(); }
      catch (error) { host.diagnostic?.(error); }
      finally { skillRefreshQueued = false; }
    }).catch((error) => { skillRefreshQueued = false; if (!closed) host.diagnostic?.(error); });
  });
  const reportFor = (turnId: string) => {
    const turn = cached.turns.find((value) => value.id === turnId);
    return turn && turn.tools.length > 0 && turn.status !== 'running' ? reportOf(turn, cached.title, cached.modelLabel) : undefined;
  };
  /** Fork before one turn and replace its prompt there; the old turn stays as a version. */
  async function branchTurn(turnId: string, text: string, fileId?: string) {
    if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(tr('请输入不超过 {limit} 字符的问题', { limit: String(MAX_MESSAGE_CHARS) }));
    if (branching) throw new Error(tr('请先停止正在运行的任务'));
    if (active === null) throw new Error(tr('请先选择一个对话'));
    const turn = cached.turns.find((value) => value.id === turnId);
    if (!turn) throw new Error(tr('找不到这条提问'));
    if (turn.status === 'running') throw new Error(tr('请先停止正在运行的任务'));
    requireConversationIdle(active);
    const entryId = Number(turnId) as EntryId;
      if (!Number.isSafeInteger(entryId)) throw new Error(tr('找不到这条提问'));
      const parent = await harness.conversation(active, BACKGROUND_CONTEXT);
    if (!parent) throw new Error(tr('对话不存在'));
    const meta = await harness.snapshot(MetadataDoc, active, BACKGROUND_CONTEXT);
    if (!meta) throw new Error(tr('对话不存在'));
    const thread = meta.branch?.thread ?? String(active);
    const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
    let index = 1;
    for (const id of preferences?.conversations ?? []) {
      const other = await harness.snapshot(MetadataDoc, id, BACKGROUND_CONTEXT);
      if ((other?.branch?.thread ?? String(id)) === thread) index = Math.max(index, (other?.branch?.index ?? 0) + 1);
    }
    const hiddenTurns = [...new Set([...(meta.branch?.hiddenTurns ?? []), turnId])];
    const attachment = fileId === undefined ? (turn.file && turn.file.available !== false ? turn.file.id : '') : fileId;
    branching = true;
    try {
      const created = await fileChange(async () => {
        const fork = await parent.fork(entryId, {
          ownership: { kind: 'ownerless' },
          init: async (tx, id) => {
            const doc = await tx.doc(MetadataDoc, id);
            doc.title = meta.title;
            doc.files = meta.files.slice();
            doc.selectedSkills = meta.selectedSkills ? [...meta.selectedSkills] : undefined;
            doc.model = meta.model;
            doc.updatedAt = Date.now();
            doc.archived = false;
            doc.branch = { thread, index, parent: String(active), hiddenTurns };
            const prefs = await tx.doc(PreferencesDoc);
            prefs.active = id;
            if (!prefs.conversations.includes(id)) prefs.conversations = [...prefs.conversations, id];
          },
        }, BACKGROUND_CONTEXT);
        // The fork includes the old prompt; remove it from model context before
        // adding the edited one. It stays in the transcript, hidden by metadata.
        const mark = await fork.submit({ type: 'write', entry: { kind: 'arxd.branch', edits: [{ target: entryId, action: 'omit' }] } }, BACKGROUND_CONTEXT);
        await mark.wait(BACKGROUND_CONTEXT);
        return fork;
      });
      active = created.id;
      entryLimit = 128;
      return await sendMessage(text, attachment);
    } finally {
      branching = false;
    }
  }

  async function sendMessage(text: string, fileId?: string) {
    if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(tr('请输入不超过 {limit} 字符的问题', { limit: String(MAX_MESSAGE_CHARS) }));
    // No global admission lock: fileChange serializes the write, another conversation
    // may already be generating, and the runtime rejects a second run inside this one
    // (`whenBusy: 'reject'`).
    const submission = await fileChange(async () => {
      const current = await conversation();
      const metadata = await harness.snapshot(MetadataDoc, current.id, BACKGROUND_CONTEXT);
      const mode = metadata?.model ?? firstMode() ?? '';
      if (!mode) throw new Error(tr('请先配置模型'));
      await connections.available(mode);
      const captured = fileId && metadata?.files.some((file) => file.id === fileId) ? await library.get(fileId) : undefined;
      const file = captured?.status === 'active' ? captured.file : undefined;
      if (fileId && !file) throw new Error(tr('附件不属于当前对话'));
      if (isLocalModelId(mode) && metadata?.selectedSkills?.length) throw new Error(tr('端侧模型不支持技能，请取消所选技能或切换模型'));
      const admitted = !isLocalModelId(mode) && host.skills ? await skills.prepare(metadata?.selectedSkills ?? []) : [];
      await current.configure({ modelTools: modelTools(mode) }, BACKGROUND_CONTEXT);
      await current.commit(async (tx) => {
        const meta = await tx.doc(MetadataDoc, current.id);
        meta.archived = false;
        if (!meta.updatedAt || meta.title === tr('新对话') || meta.title === file?.name) meta.title = text.trim().slice(0,28);
        meta.updatedAt = Date.now();
        (await tx.doc(AdmittedSkillsDoc, current.id)).items = admitted;
      }, BACKGROUND_CONTEXT);
      const marker = file ? `\n<arxd-file id="${file.id}" sha256="${file.sha256}" engine="${host.info.engineSha256}" path="${xmlAttribute(localFilePath(file.uri))}" format="${xmlAttribute(file.format)}" supported="${file.source === null ? '0' : '1'}"/>` : '';
      const selected = admitted.filter((skill) => skill.selected).map((skill) => `\n<arxd-skill id="${skill.id}" version="${skill.version}"/>`).join('');
      return current.submit({ type: 'input', content: `${text.trim()}\n\n<arxd-workspace>${marker}${selected}`, requestId: globalThis.crypto.randomUUID(), whenBusy: 'reject' }, BACKGROUND_CONTEXT);
    });
    await refresh();
    await submission.wait(BACKGROUND_CONTEXT);
    return refresh();
  }
  async function compact() {
    if (active === null) throw new Error(tr('请先选择一个对话'));
    const current = await harness.conversation(active, BACKGROUND_CONTEXT);
    if (!current) throw new Error(tr('对话不存在'));
    if ((await harness.snapshot(LiveDoc, active, BACKGROUND_CONTEXT))?.compactions?.length) throw new Error(tr('上下文正在压缩'));
    const inbox = await harness.snapshot(InboxDoc, active, BACKGROUND_CONTEXT);
    if (inbox?.items.some((item) => item.mode === 'write' && item.entry.kind === 'pi.compaction')) throw new Error(tr('压缩摘要已就绪，等待上下文边界'));
    const id = await current.compact(undefined, BACKGROUND_CONTEXT);
    await refresh();
    const receipt = await harness.waitForTask(id, BACKGROUND_CONTEXT);
    if (receipt.state.outcome.status === 'aborted') return { snapshot: await refresh(), compacted: false, cancelled: true };
    if (receipt.state.outcome.status !== 'completed') throw new Error(tr('上下文压缩未完成'));
    const submission = receipt.state.outcome.result.submissionId;
    if (submission !== undefined) await (await harness.submission(submission, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
    return { snapshot: await refresh(), compacted: receipt.state.outcome.result.entryId !== undefined || submission !== undefined, cancelled: false };
  }
  async function cancelCompaction() {
    if (active !== null) for (const item of (await harness.snapshot(LiveDoc, active, BACKGROUND_CONTEXT))?.compactions ?? []) {
      await harness.abortTask(item.taskId, BACKGROUND_CONTEXT);
      await harness.waitForTask(item.taskId, BACKGROUND_CONTEXT);
    }
    return refresh();
  }

  return {
    services: host.services && mcp ? { processes: host.services, mcp } : undefined,
    harness,
    localModel: host.localModel ? {
      status: () => host.localModel!.status(),
      download: async () => { try { await host.localModel!.download(); await connections.refreshLocal(); } finally { await refresh(); } },
      cancelDownload: () => host.localModel!.cancelOperation(),
      import: (uri: string, name: string) => fileChange(async () => {
        await requireModelIdle();
        const record = await host.localModel!.import(uri, name);
        await connections.refreshLocal();
        await refresh();
        return record;
      }),
      remove: (id: string) => fileChange(async () => {
        await requireModelIdle();
        await host.localModel!.remove(id);
        await connections.refreshLocal();
        await refresh();
      }),
    } : undefined,
    connections: {
      list: () => connections.list(),
      get: (id: string) => connections.get(id),
      catalog: (id: string, query = '') => connections.catalog(id, query),
      models: (id?: string) => connections.configured(id),
      save: (input: Pick<Connection, 'name' | 'preset' | 'protocol' | 'endpoint' | 'auth'>, id?: string, revision?: number) => fileChange(async () => { await requireModelIdle(); const value = await connections.save(input, id, revision); await refresh(); return value; }),
      credential: (id: string, value: ConnectionSecret | null) => fileChange(async () => { await requireModelIdle(); await connections.credential(id, value); return refresh(); }),
      addCatalog: (id: string, modelId: string) => fileChange(async () => { await requireModelIdle(); const value = await connections.addCatalog(id, modelId); await refresh(); return value; }),
      discoverModels: (id: string) => fileChange(async () => { await requireModelIdle(); const value = await connections.discoverModels(id); await refresh(); return value; }),
      loginAccount: (provider: Parameters<ConnectionLibrary['loginAccount']>[0], onEvent?: Parameters<ConnectionLibrary['loginAccount']>[1], signal?: AbortSignal) => fileChange(async () => { await requireModelIdle(); const value = await connections.loginAccount(provider, onEvent, signal); await refresh(); return value; }),
      logoutAccount: (id: string) => fileChange(async () => { await requireModelIdle(); await connections.logoutAccount(id); await refresh(); }),
      manual: (id: string, input: Parameters<typeof manualModel>[1], generation: Generation, enabled: boolean, identity?: string) => fileChange(async () => { await requireModelIdle(); const value = await connections.manual(id, input, generation, enabled, identity); await refresh(); return value; }),
      updateModel: (id: string, generation: Generation, enabled: boolean) => fileChange(async () => { await requireModelIdle(); const value = await connections.updateModel(id, generation, enabled); await refresh(); return value; }),
      remove: (id: string) => fileChange(async () => { await requireModelIdle(); try { await connections.remove(id); } finally { await refresh(); } }),
      test: (id: string, signal?: AbortSignal) => fileChange(async () => { await requireModelIdle(); const value = await connections.test(id, signal); await refresh(); return value; }),
    },
    skills: {
      subscribe: (listener: () => void) => skills.subscribe(listener),
      scanStatus: () => skills.scanStatus(),
      list: (query = '') => skills.list(query),
      get: (id: string) => skills.get(id),
      working: (id: string) => skills.working(id),
      refresh: () => fileChange(async () => { const records = await skills.refreshAll(await skillIdle()); await refresh(); return records; }),
      import: (kind: 'file' | 'workspace' | 'archive', source: string) => fileChange(async () => { await requireSkillIdle(); const result = await skills.import(kind, source); await refresh(); return result; }),
      enabled: (id: string, enabled: boolean) => fileChange(async () => { await requireSkillIdle(); const result = await skills.enabled(id, enabled); await refresh(); return result; }),
      save: (id: string, text: string, expected: string) => fileChange(async () => { await requireSkillIdle(); const result = await skills.save(id, text, expected); await refresh(); return result; }),
      remove: (id: string) => fileChange(async () => { await requireSkillIdle(); try { await skills.remove(id); } finally { await refresh(); } }),
      choose: (id: string, value: boolean) => fileChange(async () => {
        await requireSkillIdle();
        if (value) { const skill = await skills.get(id); if (!skill?.enabled || skill.status !== 'active') throw new Error(tr('请先启用此技能')); }
        const current = await conversation();
        await current.commit(async (tx) => {
          const meta = await tx.doc(MetadataDoc, current.id);
          meta.selectedSkills = value ? [...new Set([...(meta.selectedSkills ?? []), id])] : (meta.selectedSkills ?? []).filter((key) => key !== id);
          if (meta.selectedSkills.length > 8) throw new Error(tr('一个会话最多选择 8 个技能'));
        }, BACKGROUND_CONTEXT);
        return refresh();
      }),
    },
    fileLibrary: {
      list: (query = '', offset = 0) => library.list(query, offset),
      get: (id: string) => library.get(id),
      remember: (file: WorkspaceFile) => fileChange(async () => { const value = await library.register(file); await refresh(); return value; }),
      rename: (id: string, name: string) => fileChange(async () => { requireIdle(); await library.rename(id, name); return refresh(); }),
      remove: (id: string) => fileChange(async () => { requireIdle(); if (!host.files) throw new Error('File host is unavailable'); try { await library.remove(id, host.files); } finally { await refresh(); } }),
      async usage(id: string) {
        const result: { id: ConversationId; title: string; archived: boolean; listed: boolean }[] = [];
        const visible = (await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT))?.conversations ?? [];
        let cursor: Cursor | undefined;
        do {
          const page = await harness.commit((tx) => tx.scanConversations({}, 64, cursor), BACKGROUND_CONTEXT);
          for (const record of page.items) {
            const meta = await harness.snapshot(MetadataDoc, record.id, BACKGROUND_CONTEXT);
            if (meta?.files.some((file) => file.id === id)) result.push({ id: record.id, title: meta.title, archived: !!meta.archived, listed: visible.includes(record.id) });
          }
          cursor = page.next;
        } while (cursor);
        return result;
      },
    },
    getSnapshot: () => cached,
    subscribe(listener: (snapshot: WorkspaceSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    model: (value: ModelMode) => fileChange(async () => {
      await requireModelIdle();
      const selected = await connections.available(value);
      const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
      const level = rememberedThinking(preferences, value);
      await harness.commit(async (tx) => {
        const prefs = await tx.doc(PreferencesDoc);
        // Materialize the legacy single preference under the model it was chosen
        // for before the active model id moves on.
        if (prefs.thinking && prefs.model && prefs.model !== value && !prefs.thinkingByModel?.[prefs.model])
          prefs.thinkingByModel = { ...(prefs.thinkingByModel ?? {}), [prefs.model]: prefs.thinking };
        prefs.model = value;
        prefs.testModelMigrated = true;
      }, BACKGROUND_CONTEXT);
      // Switching the model reconfigures the open conversation; it never starts a new
      // one, so the thread and its history stay where they are.
      const current = active;
      if (current !== null) {
        const conversation = await harness.conversation(current, BACKGROUND_CONTEXT);
        await conversation?.configure({
          model: selected.ref,
          instructions: value !== 'test' ? arxdInstructions(isLocalModelId(value)) : null,
          extensions: isLocalModelId(value) ? localExtensions() : null,
          thinkingLevel: level,
          modelTools: modelTools(value),
        }, BACKGROUND_CONTEXT);
        await harness.commit(async (tx) => { (await tx.doc(MetadataDoc, current)).model = value; }, BACKGROUND_CONTEXT);
      }
      return refresh();
    }),
    async thinking(value: ModelThinkingLevel) {
      if (cached.conversations.some((c) => c.busy)) throw new Error(tr('请先停止正在运行的任务'));
      if (!thinkingLevels(cached.model).includes(value)) throw new Error(tr('此模型不支持该思考等级'));
      await harness.commit(async (tx) => {
        const preferences = await tx.doc(PreferencesDoc);
        preferences.thinking = value;
        preferences.thinkingByModel = { ...(preferences.thinkingByModel ?? {}), [cached.model]: value };
      }, BACKGROUND_CONTEXT);
      const current = active;
      if (current !== null) {
        const conversation = await harness.conversation(current, BACKGROUND_CONTEXT);
        await conversation?.configure({ thinkingLevel: value }, BACKGROUND_CONTEXT);
      }
      return refresh();
    },
    /** The store keeps conversations as documents, so this detaches the thread from
     *  the history list rather than touching stored entries. */
    async forget(id: ConversationId) {
      if (cached.conversations.some((c) => c.busy && c.id === id)) throw new Error(tr('请先停止正在运行的任务'));
      await harness.commit(async (tx) => {
        const prefs = await tx.doc(PreferencesDoc);
        prefs.conversations = prefs.conversations.filter((value) => value !== id);
        if (prefs.active === id) prefs.active = null;
      }, BACKGROUND_CONTEXT);
      if (active === id) active = null;
      return refresh();
    },
    archive: (id: ConversationId, value: boolean) => fileChange(async () => {
      await requireAvailable(database, id);
      if (!await harness.conversation(id, BACKGROUND_CONTEXT)) throw new Error(tr('对话不存在'));
      await harness.commit(async (tx) => { (await tx.doc(MetadataDoc, id)).archived = value; }, BACKGROUND_CONTEXT);
      return refresh();
    }),
    /** Titles, file names and message text, one group per conversation. */
    async search(query: string, only: ConversationId | null = null, scope: SearchScope = 'all') {
      if (query.length > 1024 || !['active', 'archived', 'all'].includes(scope)) throw new Error(tr('搜索条件无效'));
      const needle = query.trim().toLowerCase();
      if (!needle) return [] as SearchGroup[];
      const preferences = await harness.snapshot(PreferencesDoc, BACKGROUND_CONTEXT);
      const deleting = await deletingIds(database);
      const ids = (preferences?.conversations ?? []).filter((value) => !deleting.has(value) && (only === null || value === only));
      const groups: SearchGroup[] = [];
      let total = 0;
      for (const id of ids) {
        if (total >= 50) break;
        const meta = await harness.snapshot(MetadataDoc, id, BACKGROUND_CONTEXT);
        if (!meta) continue;
        if (only === null && scope !== 'all' && !!meta.archived !== (scope === 'archived')) continue;
        const hits: SearchHit[] = [];
        const titleMatch = meta.title.toLowerCase().includes(needle);
        // Messages first, then attached files: the screen separates the two groups.
        const fileHits = meta.files.filter((file) => file.name.toLowerCase().includes(needle)).slice(0, 4).map((file) => ({ kind: 'file' as const, text: file.name }));
        const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
        if (conversation) {
          const page = await conversation.entries({ order: 'descending' }, 120, undefined, BACKGROUND_CONTEXT);
          for (const entry of page.items) {
            for (const message of entry.model ?? []) {
              if (message.role !== 'user' && message.role !== 'assistant') continue;
              const raw = textOf(message.content);
              const text = message.role === 'user' ? raw.split('\n\n<arxd-workspace>')[0] : raw;
              const at = text.toLowerCase().indexOf(needle);
              if (at === -1 || hits.length >= 6) continue;
              const from = Math.max(0, at - 40);
              hits.push({ kind: 'message', text: `${from > 0 ? '…' : ''}${text.slice(from, from + 140).replace(/\s+/g, ' ').trim()}` });
              break;
            }
            if (hits.length >= 6) break;
          }
        }
        hits.push(...fileHits);
        if (hits.length || titleMatch) { groups.push({ id, title: meta.title, titleMatch, archived: !!meta.archived, hits }); total += Math.max(1, hits.length); }
      }
      return groups;
    },
    async palette(value: Palette) { if (!['fire', 'spring'].includes(value)) throw new Error('Invalid theme'); await harness.commit(async (tx) => { const preferences = await tx.doc(PreferencesDoc); preferences.palette = value; preferences.appearance = value === 'spring' ? 'light' : 'dark'; }, BACKGROUND_CONTEXT); return refresh(); },
    async theme(value: Palette) { if (!['fire', 'spring'].includes(value)) throw new Error('Invalid theme'); await harness.commit(async (tx) => { (await tx.doc(PreferencesDoc)).palette = value; }, BACKGROUND_CONTEXT); return refresh(); },
    async appearance(value: AppearanceMode) { if (!['system', 'light', 'dark'].includes(value)) throw new Error('Invalid appearance'); await harness.commit(async (tx) => { (await tx.doc(PreferencesDoc)).appearance = value; }, BACKGROUND_CONTEXT); return refresh(); },
    async motion(value: MotionMode) { if (!['system', 'reduced'].includes(value)) throw new Error('Invalid motion preference'); await harness.commit(async (tx) => { (await tx.doc(PreferencesDoc)).motion = value; }, BACKGROUND_CONTEXT); return refresh(); },
    async importLimit(value: number) { if (!Number.isSafeInteger(value) || value < MIN_IMPORT_BYTES || value > MAX_IMPORT_BYTES) throw new Error(tr('导入上限需为 {min} 到 {max} 之间的整数', { min: '1 MiB', max: '8 GiB' })); await harness.commit(async (tx) => { (await tx.doc(PreferencesDoc)).importLimit = value; }, BACKGROUND_CONTEXT); return refresh(); },
    async select(id: ConversationId | null) {
      if (id !== null) await requireAvailable(database, id);
      if (id !== null && !await harness.conversation(id, BACKGROUND_CONTEXT)) throw new Error(tr('对话不存在'));
      active = id; entryLimit = 128;
      await harness.commit(async (tx) => { (await tx.doc(PreferencesDoc)).active = id; }, BACKGROUND_CONTEXT); return refresh();
    },
    attach: (file: WorkspaceFile) => fileChange(() => attachFile(file)),
    attachExisting: (id: string) => fileChange(async () => {
      const record = await library.get(id);
      if (!record || record.status !== 'active') throw new Error(tr('文件已删除或正在删除'));
      return attachFile(record.file);
    }),
    captureFile: (root: FileRoot, path: string) => fileChange(async () => {
      requireIdle(); if (!host.files) throw new Error('File host is unavailable');
      const file = await host.files.capture(root, path);
      await library.register(file); await refresh(); return file;
    }),
    /** Assembled on demand; neither browsing nor snapshots materialize reports. */
    report: reportFor,
    saveReport: (turnId: string) => fileChange(async () => {
      const artifact = reportFor(turnId);
      if (!artifact || !host.files) throw new Error(tr('产物不可用'));
      const old = await library.artifact(artifact.id);
      if (old) { if (old.status !== 'active') throw new Error(tr('文件正在删除，请稍后重试')); return old.file; }
      const file = await host.files.save(artifact.name, artifact.content);
      await library.register(file, 'generated', artifact.id); return file;
    }),
    send: sendMessage,
    compact,
    cancelCompaction,
    editTurn: (turnId: string, text: string, fileId?: string) => branchTurn(turnId, text, fileId),
    regenerate: (turnId: string) => {
      const turn = cached.turns.find((value) => value.id === turnId);
      if (!turn) return Promise.reject(new Error(tr('找不到这条提问')));
      return branchTurn(turnId, turn.prompt);
    },
    async stop() { if (active !== null) { const current = await harness.conversation(active, BACKGROUND_CONTEXT); await current?.abort(BACKGROUND_CONTEXT); } return refresh(); },
    async earlier() { if (entryLimit >= 2048) throw new Error(tr('当前界面的历史读取上限为 2048 条记录')); entryLimit *= 2; return refresh(); },
    async close() { closed = true; capacity.close(); unwatchSkills?.(); clearTimeout(refreshTimer); unsubscribe(); await fileTail; await refreshTail; await harness.close(BACKGROUND_CONTEXT); await host.localModel?.release(); },
  };
}

export type WorkspaceSession = Awaited<ReturnType<typeof openWorkspaceSession>>;
export type Workspace = WorkspaceController;
