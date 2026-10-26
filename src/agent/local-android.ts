import { AppState } from 'react-native';
import { backgroundActive } from '../background/android';
import type { LlamaContext } from 'llama.rn';
import Rxd from '../../modules/rxd';
import { LOCAL_CONTEXT, LOCAL_MAX_TOKENS, type LocalRun, type LocalModelHost, type LocalModelRecord, type LocalRequest } from './local-provider';

let context: LlamaContext | undefined;
let loadedId: string | undefined;
let busy = false;
let lastRun: LocalRun | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let cancelActive: (() => void) | undefined;
let releasing: Promise<void> | undefined;

const loadOptions = (model: string, contextWindow: number) => ({
  model, n_ctx: contextWindow, n_batch: 256, n_ubatch: 128, n_threads: 4, n_parallel: 1,
  n_gpu_layers: 0, use_mmap: true, use_mlock: false, ctx_shift: false, state_cache_budget_mb: 64,
});

async function unload() {
  clearTimeout(releaseTimer);
  const old = context;
  context = undefined;
  loadedId = undefined;
  await old?.release();
}

function release(): Promise<void> {
  if (releasing) return releasing;
  if (busy) return Promise.reject(new Error('端侧模型正在使用'));
  busy = true;
  const old = context;
  context = undefined;
  loadedId = undefined;
  releasing = Promise.resolve().then(() => old?.release()).then(() => undefined).finally(() => { busy = false; releasing = undefined; });
  return releasing;
}

AppState.addEventListener('change', (state) => {
  if (state === 'active' || backgroundActive()) return;
  cancelActive?.();
  if (!busy) void release().catch(() => undefined);
});

const PROBE_MESSAGES: LocalRequest['messages'] = [
  { role: 'system', content: 'You are a compatibility probe.' },
  { role: 'user', content: 'Call rxd_probe with value ok.' },
];
const PROBE_TOOLS: LocalRequest['tools'] = [{
  type: 'function',
  function: {
    name: 'rxd_probe', description: 'Compatibility probe',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  },
}];

/**
 * Prove the file is loadable, has a Jinja template and exposes a native
 * structured tool parser. This is the import gate; no model name allowlist.
 */
async function probeModel(id: string): Promise<{ contextWindow: number; maxTokens: number; architecture: string; thinking: boolean }> {
  const { initLlama, loadLlamaModelInfo } = await import('llama.rn');
  const path = await Rxd.verifiedLocalModelPath(id);
  const info = await loadLlamaModelInfo(path) as Record<string, unknown>;
  const architecture = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
  if (!architecture) throw new Error('缺少 GGUF 架构元数据');
  const template = info['tokenizer.chat_template'];
  if (typeof template !== 'string' || !template.trim()) throw new Error('模型缺少聊天模板');
  const trained = Number(info[`${architecture}.context_length`] ?? 0);
  if (Number.isFinite(trained) && trained > 0 && trained < 2048) throw new Error(`训练上下文过小（${Math.floor(trained)}）`);
  const contextWindow = Math.min(LOCAL_CONTEXT, Math.max(2048, Number.isFinite(trained) && trained > 0 ? Math.floor(trained) : LOCAL_CONTEXT));
  const probe = await initLlama(loadOptions(path, contextWindow));
  let thinking = false;
  try {
    if (!probe.isJinjaSupported()) throw new Error('不支持 Jinja 聊天模板');
    const formatted = await probe.getFormattedChat(PROBE_MESSAGES, undefined, {
      jinja: true, tools: PROBE_TOOLS, enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'none',
    });
    if (formatted.type !== 'jinja') throw new Error('聊天模板未返回 Jinja 结果');
    if (!('chat_parser' in formatted) || !formatted.chat_parser) throw new Error('不支持结构化工具调用');
    const { tokens } = await probe.tokenize(formatted.prompt);
    if (!tokens.length) throw new Error('分词器不可用');
    // The template alone cannot tell us whether thinking is toggleable: format
    // the same probe with it enabled and require a different prompt plus a
    // structured parser. No model-name allowlist.
    try {
      const formattedThinking = await probe.getFormattedChat(PROBE_MESSAGES, undefined, {
        jinja: true, tools: PROBE_TOOLS, enable_thinking: true,
        chat_template_kwargs: { enable_thinking: true }, reasoning_format: 'none',
      });
      thinking = formattedThinking.type === 'jinja' && formattedThinking.prompt !== formatted.prompt &&
        'chat_parser' in formattedThinking && !!formattedThinking.chat_parser;
    } catch { /* Treat a template that rejects the switch as non-thinking. */ }
  } finally { await probe.release(); }
  return {
    contextWindow,
    maxTokens: Math.max(128, Math.min(LOCAL_MAX_TOKENS, Math.floor(contextWindow / 4))),
    architecture, thinking,
  };
}

export const androidLocalModel: LocalModelHost = {
  status: () => {
    const native = Rxd.localModelStatus();
    return { ...native, busy, loaded: !!context, loadedId, lastRun };
  },
  async download() {
    if (busy || releasing) throw new Error('端侧模型正在使用');
    if (Rxd.localModelStatus().operation !== 'idle') throw new Error('端侧模型正在执行其他操作');
    busy = true;
    try { await Rxd.downloadLocalModel(); } finally { busy = false; }
  },
  cancelOperation: () => Rxd.cancelLocalModelOperation(),
  async import(uri, name) {
    if (busy || releasing) throw new Error('端侧模型正在使用');
    if (Rxd.localModelStatus().operation !== 'idle') throw new Error('端侧模型正在执行其他操作');
    busy = true;
    clearTimeout(releaseTimer);
    try {
      await unload();
      const record = await Rxd.importLocalModel(uri, name);
      try {
        const limits = await probeModel(record.id);
        await Rxd.setLocalModelLimits(record.id, limits.contextWindow, limits.maxTokens, limits.thinking);
        // The native record still carries the pre-probe defaults.
        return { ...record, ...limits, maxTokens: limits.maxTokens };
      } catch (error) {
        // Never keep a newly copied model that cannot run here; a deduplicated
        // record predates this import and is left untouched.
        if (record.imported) await Rxd.removeLocalModel(record.id).catch(() => undefined);
        throw new Error(`端侧模型不兼容：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally { busy = false; }
  },
  async remove(id: string) {
    if (busy || releasing) throw new Error('端侧模型正在使用');
    busy = true;
    clearTimeout(releaseTimer);
    try {
      if (loadedId === id) await unload();
      await Rxd.removeLocalModel(id);
    } finally { busy = false; }
  },
  release,
  async generate(modelId, request, signal, onThinking, onContent) {
    if (releasing) await releasing;
    if (busy) throw new Error('端侧模型正在使用，请稍后重试');
    const record: LocalModelRecord | undefined = Rxd.localModelStatus().models.find((model) => model.id === modelId);
    if (!record || !record.available) throw new Error('端侧模型不可用，请重新下载或导入');
    if (request.thinking && !record.thinking) throw new Error('该端侧模型不支持思考');
    if (signal.aborted || (AppState.currentState === 'background' && !backgroundActive())) throw new Error('Local generation cancelled or app is in background');
    busy = true; clearTimeout(releaseTimer);
    const started = Date.now();
    let cold = false;
    let loadMs = 0;
    let stopped = false;
    let callbackError: unknown;
    const stop = () => {
      stopped = true;
      Rxd.cancelLocalModelOperation();
      // The pinned JSI stop returns void on Android despite its Promise type.
      try { void Promise.resolve(context?.stopCompletion()).catch(() => undefined); } catch { /* final completion still owns cleanup */ }
    };
    cancelActive = stop;
    signal.addEventListener('abort', stop, { once: true });
    const check = () => { if (stopped || signal.aborted) throw new Error('Local generation cancelled'); };
    try {
      check();
      if (context && loadedId !== modelId) { await unload(); check(); }
      if (!context) {
        cold = true;
        const path = await Rxd.verifiedLocalModelPath(modelId);
        check();
        const { initLlama } = await import('llama.rn');
        context = await initLlama(loadOptions(path, record.contextWindow));
        loadedId = modelId;
        check();
        if (!context.isJinjaSupported()) throw new Error(`${record.name} 不支持 Jinja 聊天模板`);
      }
      loadMs = cold ? Date.now() - started : 0;
      const params = { messages: request.messages, tools: request.tools.length ? request.tools : undefined, jinja: true, enable_thinking: request.thinking, chat_template_kwargs: { enable_thinking: request.thinking }, reasoning_format: request.thinking ? 'auto' as const : 'none' as const, now: Math.floor(Date.now() / 1000) };
      const formatted = await context.getFormattedChat(request.messages, undefined, params);
      const { tokens } = await context.tokenize(formatted.prompt);
      check();
      if (tokens.length + request.maxTokens + 32 > record.contextWindow) throw new Error('端侧模型上下文不足；请压缩上下文或新建对话');
      if (formatted.type !== 'jinja' || !('chat_parser' in formatted) || !formatted.chat_parser) throw new Error('端侧模型缺少结构化工具解析器');
      const emptyThinking = '<think>\n\n</think>\n\n';
      // generation_prompt also contains the assistant-role header. The native
      // parser drops that header but echoes this known empty input suffix.
      const emptyPrefill = formatted.prompt.endsWith(emptyThinking) ? emptyThinking : '';
      const contentOnly = (value: string | undefined) => {
        const text = value ?? '';
        if (emptyPrefill && emptyPrefill.startsWith(text)) return '';
        return emptyPrefill && text.startsWith(emptyPrefill) ? text.slice(emptyPrefill.length) : text;
      };
      if (Rxd.verificationEnabled()) Rxd.report(JSON.stringify({ event: 'arxd-local-request', model: modelId, promptTokens: tokens.length, cold, loadMs, thinking: request.thinking, emptyPrefillBytes: emptyPrefill.length }));
      // Feed the exact already-counted prompt and native parser. The pinned
      // engine rejects the generated Qwen/tool GBNF on Android; do not install
      // that sampling grammar. All emitted calls still undergo Pi schema
      // validation before toolcall events/execution (no repair or fallback).
      const result = await context.completion({ prompt: formatted.prompt, chat_format: formatted.chat_format,
        chat_parser: formatted.chat_parser, preserved_tokens: formatted.preserved_tokens,
        stop: formatted.additional_stops, generation_prompt: formatted.generation_prompt,
        thinking_forced_open: formatted.thinking_forced_open,
        ...{ thinking_start_tag: formatted.thinking_start_tag, thinking_end_tag: formatted.thinking_end_tag },
        n_predict: request.maxTokens, temperature: 0.2, top_p: 0.95, top_k: 20, min_p: 0, penalty_present: 0, penalty_repeat: 1 }, (event) => {
        if (stopped || signal.aborted || callbackError) return;
        try {
          if (typeof event.reasoning_content === 'string') onThinking(event.reasoning_content);
          if (typeof event.content === 'string') onContent(contentOnly(event.content));
        } catch (error) { callbackError = error; stop(); }
      });
      if (callbackError) throw callbackError;
      check();
      if (result.interrupted) throw new Error('Local generation interrupted');
      if (result.truncated || result.context_full) throw new Error('端侧模型上下文已耗尽；未执行工具调用');
      lastRun = { cold, loadMs, totalMs: Date.now() - started, promptTokens: tokens.length, generatedTokens: result.tokens_predicted, promptMs: result.timings.prompt_ms, generationMs: result.timings.predicted_ms };
      if (Rxd.verificationEnabled()) Rxd.report(JSON.stringify({ event: 'arxd-local-inference', model: modelId, ...lastRun }));
      return { reasoning: result.reasoning_content ?? '', content: contentOnly(result.content), toolCalls: (result.tool_calls ?? []).map((call) => ({ id: call.id, ...call.function })), inputTokens: tokens.length, outputTokens: result.tokens_predicted, limited: !!result.stopped_limit };
    } catch (error) {
      // Discard recurrent/cache state after cancellation or failed inference.
      const old = context; context = undefined; loadedId = undefined; await old?.release();
      throw error;
    } finally {
      signal.removeEventListener('abort', stop); cancelActive = undefined; busy = false;
      if (context) releaseTimer = setTimeout(() => { if (!busy) void release().catch(() => undefined); }, AppState.currentState === 'background' ? 0 : 60000);
    }
  },
};
