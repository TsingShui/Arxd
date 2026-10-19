import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, validateToolArguments, type AssistantMessage, type ProviderStreams, type TranscriptContext } from '@earendil-works/pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import manifest from '../../modules/rxd/android/src/main/assets/qwen-model.json' with { type: 'json' };
import type { LocalModelRecord } from '../../modules/rxd';

/**
 * On-device models share one Pi provider. The internal ids keep their original
 * spelling so conversations written by the pinned-only build still resolve;
 * the product name is 端侧模型.
 */
export const LOCAL_PROVIDER_ID = 'arxd-local-qwen';
export const LOCAL_API = 'arxd-local-qwen-v1';
export const LOCAL_ENGINE = 'llama.rn-0.12.9:v1';
export const PINNED_MODEL_ID = manifest.id;
export const PINNED_MODEL_NAME = manifest.model.split('/').at(-1) ?? manifest.model;
export const LOCAL_CONTEXT = manifest.contextWindow;
export const LOCAL_MAX_TOKENS = manifest.maxTokens;
export const MAX_LOCAL_MODEL_BYTES = 8 * 1024 ** 3;
export type { LocalModelRecord };

export type LocalOperation = 'idle' | 'downloading' | 'importing' | 'verifying' | 'removing';
export type LocalRun = { cold: boolean; loadMs: number; totalMs: number; promptTokens: number; generatedTokens: number; promptMs: number; generationMs: number };
export type LocalStatus = { operation: LocalOperation; bytes: number; totalBytes: number; busy: boolean; loaded: boolean; loadedId?: string; lastRun?: LocalRun; models: LocalModelRecord[] };
export type LocalChatMessage = { role: string; content: string; tool_call_id?: string; name?: string; tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string } }[] };
export type LocalRequest = { messages: LocalChatMessage[]; tools: { type: 'function'; function: { name: string; description: string; parameters: object } }[]; maxTokens: number; thinking: boolean };
export type LocalResult = { reasoning: string; content: string; toolCalls: { id?: string; name: string; arguments: string }[]; inputTokens: number; outputTokens: number; limited: boolean };
export type LocalModelHost = {
  status(): LocalStatus;
  download(): Promise<void>;
  cancelOperation(): void;
  import(uri: string, name: string): Promise<LocalModelRecord>;
  remove(id: string): Promise<void>;
  release(): Promise<void>;
  generate(modelId: string, request: LocalRequest, signal: AbortSignal, onThinking: (reasoning: string) => void, onContent: (content: string) => void): Promise<LocalResult>;
};

/** Choice ids are stable across restarts; imported models use content ids. */
export function isLocalModelId(id?: string): id is string {
  return !!id && (id === PINNED_MODEL_ID || /^gguf-[0-9a-f]{16}$/.test(id));
}

export function localDefinition(record: LocalModelRecord) {
  return {
    id: record.id === PINNED_MODEL_ID ? manifest.model : record.id,
    name: record.name, provider: LOCAL_PROVIDER_ID, api: LOCAL_API, baseUrl: '',
    input: ['text'] as ('text')[], reasoning: record.thinking, contextWindow: record.contextWindow, maxTokens: record.maxTokens,
    // The GGUF template exposes a boolean thinking switch, not effort levels.
    ...(record.thinking ? { thinkingLevelMap: { off: 'off', minimal: null, low: null, medium: 'medium', high: null, xhigh: null, max: null } } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export const PINNED_MODEL: LocalModelRecord = {
  id: PINNED_MODEL_ID, name: PINNED_MODEL_NAME, bytes: manifest.bytes, sha256: manifest.sha256,
  source: 'download', contextWindow: manifest.contextWindow, maxTokens: manifest.maxTokens, thinking: manifest.thinking === true, available: false,
};
export const LOCAL_MODEL = localDefinition(PINNED_MODEL);

/** Revisions bind an estimate/transcript to exact weights and engine settings. */
export function localRevision(record: LocalModelRecord): string {
  return `${LOCAL_ENGINE}:${record.sha256}:${record.contextWindow}:${record.maxTokens}:${record.thinking ? 'thinking' : 'plain'}`;
}
export function localProviderRevision(models: LocalModelRecord[]): string {
  return `${LOCAL_ENGINE}:${models.map((model) => `${model.id}:${model.sha256}:${model.contextWindow}:${model.maxTokens}:${model.thinking}`).sort().join(',')}`;
}

/** Replay Pi's prompt/tool deltas, not just the first system message. Never drop images silently. */
function requestFor(context: TranscriptContext, maxTokens: number, thinking: boolean): LocalRequest {
  if (context.messages.length > 512) throw new Error('端侧模型消息超出预算；请压缩上下文或新建对话');
  const text = (content: string | { type: string; text?: string }[]) => {
    if (typeof content === 'string') return content;
    if (content.some((part) => !['text', 'thinking', 'toolCall'].includes(part.type))) throw new Error('端侧模型仅支持文本');
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  };
  const messages: LocalChatMessage[] = [{ role: 'system', content: getCurrentSystemPrompt(context.messages) }];
  for (const message of context.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)) continue;
    if (message.role === 'toolResult') {
      messages.push({ role: 'tool', content: `${message.isError ? 'Tool failed:\n' : ''}${text(message.content)}`, tool_call_id: message.toolCallId, name: message.toolName });
    } else if (message.role === 'assistant') {
      const calls = message.content.filter((part) => part.type === 'toolCall').map((call) => ({ type: 'function' as const, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      messages.push({ role: 'assistant', content: text(message.content), ...(calls.length ? { tool_calls: calls } : {}) });
    } else messages.push({ role: 'user', content: text(message.content) });
  }
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  if (messages.slice(lastUser + 1).filter((message) => message.role === 'assistant' && message.tool_calls?.length).length >= 4) throw new Error('端侧模型工具轮次已达上限（4）；请发送新问题继续');
  const tools = getCurrentTools(context.messages).map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const request = { messages, tools, maxTokens, thinking };
  if (tools.length > 64 || JSON.stringify(request).length > 262144) throw new Error('端侧模型请求超出预算；请压缩上下文或新建对话');
  return request;
}

export function localProvider(host: LocalModelHost) {
  // The provider is rebuilt whenever model configuration reloads, so imports and
  // deletions become visible without restarting the workspace.
  const definitions = host.status().models.map(localDefinition);
  if (!definitions.some((model) => model.id === LOCAL_MODEL.id)) definitions.push(LOCAL_MODEL);
  const stream: ProviderStreams['stream'] = (model, context, options = {}) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    void (async () => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const timeout = setTimeout(cancel, Math.min(options.timeoutMs ?? 120000, 180000));
      try {
        const maxTokens = Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens);
        if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('Invalid local output budget');
        // streamSimple carries Pi's reasoning level; off/absent keeps the fast path.
        const level = (options as { reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }).reasoning;
        const thinking = !!model.reasoning && !!level;
        const request = requestFor(context, maxTokens, thinking);
        if (abort.signal.aborted) throw new Error('Local generation cancelled');
        events.push({ type: 'start', partial: message });
        let reasoningIndex = -1;
        let reasoningClosed = false;
        let textIndex = -1;
        const update = (reasoning: string, content: string) => {
          if (abort.signal.aborted) return;
          if (reasoning.length > 65536 || content.length > 65536) throw new Error('Local output exceeds budget');
          if (reasoning) {
            if (reasoningIndex < 0) {
              reasoningIndex = message.content.length;
              message.content.push({ type: 'thinking', thinking: '' });
              events.push({ type: 'thinking_start', contentIndex: reasoningIndex, partial: message });
            }
            const block = message.content[reasoningIndex];
            if (block.type !== 'thinking') throw new Error('Local parser changed its reasoning block');
            if (!reasoning.startsWith(block.thinking)) throw new Error('Local parser returned non-monotonic reasoning');
            const delta = reasoning.slice(block.thinking.length);
            if (delta) {
              if (reasoningClosed) throw new Error('Local parser emitted reasoning after the answer');
              block.thinking = reasoning;
              events.push({ type: 'thinking_delta', contentIndex: reasoningIndex, delta, partial: message });
            }
          }
          if (content) {
            if (reasoningIndex >= 0 && !reasoningClosed) {
              const block = message.content[reasoningIndex];
              if (block.type === 'thinking') events.push({ type: 'thinking_end', contentIndex: reasoningIndex, content: block.thinking, partial: message });
              reasoningClosed = true;
            }
            if (textIndex < 0) {
              textIndex = message.content.length;
              message.content.push({ type: 'text', text: '' });
              events.push({ type: 'text_start', contentIndex: textIndex, partial: message });
            }
            const block = message.content[textIndex];
            if (block.type !== 'text') throw new Error('Local parser changed its text block');
            if (!content.startsWith(block.text)) throw new Error('Local parser returned non-monotonic text');
            const delta = content.slice(block.text.length);
            if (delta) { block.text = content; events.push({ type: 'text_delta', contentIndex: textIndex, delta, partial: message }); }
          }
        };
        let reasoning = '', content = '';
        const result = await host.generate(
          model.id === LOCAL_MODEL.id ? PINNED_MODEL_ID : model.id,
          request, abort.signal,
          (value) => { reasoning = value; update(reasoning, content); },
          (value) => { content = value; update(reasoning, content); },
        );
        if (abort.signal.aborted) throw new Error('Local generation cancelled or timed out');
        reasoning = result.reasoning; content = result.content;
        update(reasoning, content);
        if (reasoningIndex >= 0 && !reasoningClosed) {
          const block = message.content[reasoningIndex];
          if (block.type === 'thinking') events.push({ type: 'thinking_end', contentIndex: reasoningIndex, content: block.thinking, partial: message });
          reasoningClosed = true;
        }
        if (textIndex >= 0) {
          const block = message.content[textIndex];
          if (block.type === 'text') events.push({ type: 'text_end', contentIndex: textIndex, content: block.text, partial: message });
        }
        // A token-limited response must never execute an incomplete tool invocation.
        if (result.limited && result.toolCalls.length) throw new Error('Local tool call exceeded output budget');
        if (result.toolCalls.length > 8) throw new Error('Local tool call budget exceeded');
        const tools = getCurrentTools(context.messages);
        const calls = result.toolCalls.map((call, index) => {
          if (call.arguments.length > 32768) throw new Error('Local tool arguments exceed budget');
          const tool = tools.find((entry) => entry.name === call.name);
          if (!tool) throw new Error(`Local model requested unknown tool: ${call.name}`);
          const value = { type: 'toolCall' as const, id: `local-${globalThis.crypto.randomUUID()}-${index}`, name: call.name, arguments: JSON.parse(call.arguments) };
          value.arguments = validateToolArguments(tool, value);
          return value;
        });
        if (!result.content.trim() && !calls.length) throw new Error('Local model returned no text or tool call');
        message.thinkingLevel = thinking ? level : 'off';
        for (const call of calls) {
          const index = message.content.length;
          message.content.push({ ...call, arguments: {} });
          events.push({ type: 'toolcall_start', contentIndex: index, partial: message });
          message.content[index] = call;
          events.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
          events.push({ type: 'toolcall_end', contentIndex: index, toolCall: call, partial: message });
        }
        message.usage.input = result.inputTokens; message.usage.output = result.outputTokens; message.usage.totalTokens = result.inputTokens + result.outputTokens;
        message.stopReason = result.limited ? 'length' : calls.length ? 'toolUse' : 'stop';
        events.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = abort.signal.aborted ? 'aborted' : 'error';
        message.errorMessage = String(error).slice(0, 1000);
        events.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel); events.end(); }
    })();
    return events;
  };
  return createProvider({ id: LOCAL_PROVIDER_ID, name: '端侧模型', auth: { apiKey: { name: 'On-device', resolve: async () => ({ auth: {} }) } }, models: definitions, api: { stream, streamSimple: stream } });
}
