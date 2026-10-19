import { requireVerification } from './access';
import { lazyStream, type AssistantMessage, type TranscriptContext, type Usage } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
let generation: (() => Promise<void>) | undefined;
export function setCapacityGeneration(value?: () => Promise<void>) { generation = value; }
let summary: 'normal' | 'error' | (() => Promise<void>) = 'normal';
export function setCapacitySummary(value: typeof summary) { summary = value; }
type CapacityStreamProbe = { requests: number; deltas: number; terminals: number; contexts: TranscriptContext[]; beforeTerminal?(): Promise<void> };
let streamProbe: CapacityStreamProbe | undefined;
let usageFixture: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens'> | undefined;
/** Malformed and normalized usage is admitted at the real provider/storage boundary. */
export function setCapacityUsageFixture(value?: typeof usageFixture) { requireVerification(); usageFixture = value; }
/** Opt-in isolated Android verification only; live providers are never decorated. */
export function setCapacityStreamProbe(value?: CapacityStreamProbe) { requireVerification(); streamProbe = value; }
/** Explicit offline provider boundary; usage values are fixture data, never a live billing claim. */
export async function capacityVerificationResponse(context: Parameters<FauxResponseFactory>[0], signal?: AbortSignal) {
  if (context.messages.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('You are a context summarization assistant.'))) {
    if (summary === 'error') return fauxAssistantMessage(fauxText(''), { stopReason: 'error', errorMessage: 'Offline capacity compaction failure' });
    if (typeof summary === 'function') { await Promise.race([summary(), new Promise<never>((_, reject) => { if (signal?.aborted) reject(new Error('aborted')); else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); })]); return fauxAssistantMessage(fauxText('Offline capacity summary.')); }
    return undefined;
  }
  if (streamProbe) { streamProbe.requests++; streamProbe.contexts.push(structuredClone(context)); }
  const last = context.messages.filter((message) => message.role === 'user').at(-1);
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  if (text?.includes('<arxd-capacity-stream/>')) {
    await generation?.();
    const userIndex = context.messages.lastIndexOf(last!);
    const result = context.messages.slice(userIndex + 1).some((message) => message.role === 'toolResult' && message.toolName === 'skill_search');
    return fauxAssistantMessage([
      fauxThinking('Offline streamed capacity reasoning. '.repeat(32)),
      fauxText('Offline streamed capacity text. '.repeat(32)),
      ...(result ? [] : [fauxToolCall('skill_search', { query: 'capacity-stream-fixture' }, { id: 'capacity-stream-search' })]),
    ], { stopReason: result ? 'stop' : 'toolUse' });
  }
  const marker = /<arxd-capacity-probe tokens="(\d+)"\/>/.exec(text ?? '');
  if (!marker) return undefined;
  await generation?.();
  const tokens = Math.min(200000, Number(marker[1]));
  const response = fauxAssistantMessage(fauxText('Offline capacity fixture; usage is independently specified.'), { responseId: `arxd-capacity-fixture:${tokens}` });
  response.usage = { ...response.usage, input: Math.max(0, tokens - 8000), output: 0, cacheRead: Math.min(8000, tokens), cacheWrite: 0, totalTokens: tokens };
  return response;
}

/** Pi AI 1.3 fauxProvider always replaces factory usage with its own estimate.
 * Preserve independently declared fixture accounting at its public terminal
 * stream boundary. This wrapper is installed on faux only; live providers and
 * ordinary faux messages keep their own usage. No transcript is rewritten.
 */
export function capacityVerificationProvider(provider: Provider): Provider {
  const fixed = (message: AssistantMessage): AssistantMessage => {
    if (usageFixture) return { ...message, usage: { ...message.usage, ...usageFixture } };
    if (streamProbe) return { ...message, usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
    const marker = /^arxd-capacity-fixture:(\d{1,6})$/.exec(message.responseId ?? '');
    if (!marker) return message;
    const tokens = Number(marker[1]);
    if (tokens > 200000) return message;
    return { ...message, usage: { ...message.usage, input: Math.max(0, tokens - 8000), output: 0, cacheRead: Math.min(8000, tokens), cacheWrite: 0, totalTokens: tokens } };
  };
  const decorate = (model: Parameters<Provider['streamSimple']>[0], upstream: ReturnType<Provider['streamSimple']>) => lazyStream(model, async () => (async function* () {
    for await (const event of upstream) {
      if (streamProbe && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type)) { streamProbe.deltas++; await new Promise((resolve) => setTimeout(resolve, 8)); }
      if (streamProbe && (event.type === 'done' || event.type === 'error')) { streamProbe.terminals++; await streamProbe.beforeTerminal?.(); }
      if (event.type === 'done') yield { ...event, message: fixed(event.message) };
      else if (event.type === 'error') yield { ...event, error: fixed(event.error) };
      else yield event;
    }
  })());
  return { ...provider, stream: (model, context, options) => decorate(model, provider.stream(model, context, options)), streamSimple: (model, context, options) => decorate(model, provider.streamSimple(model, context, options)) };
}
