import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId, type EntryRecord, type JsonObject, type TaskId } from '@earendil-works/pi-durable';
import type { WorkspaceFile } from '../../modules/rxd/index.ts';
import type { RequestFailure, RetryMessage } from '../agent/request-retry.ts';
import type { TurnTiming } from './activity.ts';

export type ToolView = {
  id: string; name: string; text: string; details: unknown; isError: boolean;
  records: JsonObject[]; durationMs?: number; arguments?: ToolCall['arguments'];
};
export type ActivityBlock =
  | { kind: 'request-error'; id: string; failure: RequestFailure; partial: boolean }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; timingKey: string; live: boolean }
  | { kind: 'tool'; id: string; name: string; callId: string; arguments: ToolCall['arguments']; timingKey: string; state: 'pending' | 'running' | 'done' | 'error' | 'stopped'; result?: ToolView; output?: string };
export type TurnView = {
  id: string; prompt: string; file: WorkspaceFile | null; answer: string;
  tokens: number; cost: number; provider?: string; modelId?: string; modelLabel: string;
  calls: { id: string; name: string }[]; tools: ToolView[]; activities: ActivityBlock[];
  requestErrors?: RequestFailure[]; recovery?: { attempt: number; at: number; error: string };
  startedAt: number; endedAt?: number; timing?: TurnTiming;
  phase?: 'waiting' | 'thinking' | 'answer' | 'tool' | 'preparing' | 'recovery';
  status: 'running' | 'done' | 'failed' | 'stopped';
};

export function textOf(content: UserMessage['content'] | AssistantMessage['content'] | ToolResultMessage['content']): string {
  return typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export function appendActivity(turn: TurnView, message: AssistantMessage, request: string, live: boolean) {
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
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value as JsonObject] : [];
    } catch { return []; }
  });
}

type TurnProjectionOptions = {
  files: readonly WorkspaceFile[];
  hiddenTurns?: readonly string[];
  modelLabel: string;
  responseLabel: (provider: string, model: string) => string;
};

/** Project a descending durable history page without reading storage or changing
 * its entries. Live state, task outcomes and timing are applied by the workspace. */
export function projectTurns(entries: readonly EntryRecord[], { files, hiddenTurns, modelLabel, responseLabel }: TurnProjectionOptions) {
  const turns: TurnView[] = [];
  const lastModelTasks = new Map<TurnView, { id: TaskId; conversationId: ConversationId }>();
  for (const entry of entries.slice().reverse()) {
    if (UserEntry.is(entry)) {
      if (hiddenTurns?.includes(String(entry.id))) continue;
      const message = entry.model?.find((m): m is UserMessage => m.role === 'user');
      if (!message) continue;
      const text = textOf(message.content);
      const fileId = /<arxd-file id="([a-f0-9-]+)"/.exec(text)?.[1];
      turns.push({
        id: String(entry.id), prompt: text.split('\n\n<arxd-workspace>')[0],
        file: files.find((f) => f.id === fileId) ?? null, answer: '',
        activities: [], calls: [], tools: [], tokens: 0, cost: 0, modelLabel,
        startedAt: message.timestamp, status: 'stopped',
      });
    } else if (AssistantEntry.is(entry)) {
      const turn = turns.at(-1);
      if (!turn) continue;
      for (const message of entry.model ?? []) {
        if (message.role !== 'assistant') continue;
        if (entry.byTaskId !== undefined) lastModelTasks.set(turn, { id: entry.byTaskId, conversationId: entry.conversationId });
        const failure = (message as RetryMessage).arxdFailure;
        if (failure) (turn.requestErrors ??= []).push(failure);
        appendActivity(turn, message, `${entry.byTaskId ?? entry.id}/${message.timestamp}`, false);
        turn.tokens += message.usage.totalTokens;
        turn.cost += message.usage.cost.total;
        turn.provider = message.provider;
        turn.modelId = message.model;
        turn.modelLabel = responseLabel(message.provider, message.model);
        turn.calls.push(...message.content.filter((p) => p.type === 'toolCall').map((p) => ({ id: p.id, name: p.name })));
        if (['stop', 'error', 'aborted', 'length'].includes(message.stopReason)) {
          if (message.durationMs !== undefined) turn.endedAt = message.timestamp + message.durationMs;
          turn.answer = textOf(message.content);
          if (!turn.answer && !failure && message.errorMessage) turn.answer = message.errorMessage;
          if (message.stopReason === 'aborted') turn.status = 'stopped';
          else if (message.stopReason === 'error' || message.stopReason === 'length' || turn.tools.at(-1)?.isError) turn.status = 'failed';
          else turn.status = 'done';
        }
      }
    } else if (ToolResultEntry.is(entry)) {
      const turn = turns.at(-1);
      if (!turn) continue;
      for (const message of entry.model ?? []) {
        if (message.role !== 'toolResult') continue;
        const text = textOf(message.content);
        const tool: ToolView = { id: message.toolCallId, name: message.toolName, text, details: message.details, isError: !!message.isError,
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          records: message.toolName.startsWith('rxd_') && !message.isError ? parseRecords(text) : [] };
        turn.tools.push(tool);
        const block = turn.activities.findLast((block) => block.kind === 'tool' && block.callId === message.toolCallId && !block.result);
        if (block?.kind === 'tool') {
          block.timingKey = `tool:${entry.byTaskId ?? block.id}`;
          block.result = tool;
          tool.arguments = block.arguments;
          const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
          if (!tool.isError) block.state = 'done';
          else if (diagnostics.some((item) => /abort|interrupt/.test(item.code ?? ''))) block.state = 'stopped';
          else block.state = 'error';
        }
      }
    }
  }
  return { turns, lastModelTasks };
}
