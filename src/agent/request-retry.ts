import type { Api, ApiStreamOptions, AssistantMessage, Model, StreamOptions } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const REQUEST_TIMEOUT_MS = 90_000;
export const REQUEST_TOTAL_MS = 367_000;
// Persisted with a charged dispatch. A new process cannot replay that dispatch.
export const requestEpoch = globalThis.crypto.randomUUID();
export type RequestIdentity = { id: string; attempt: number; stage: 'generation' | 'compaction'; deadlineAt: number };
export type RequestFailure = RequestIdentity & { category: 'network' | 'timeout' | 'http' | 'protocol' | 'configuration' | 'certificate' | 'unknown' | 'cancelled' | 'budget'; message: string; retryable: boolean; status?: number; requestId?: string; providerCode?: string };
export type RetryMessage = AssistantMessage & { arxdFailure?: RequestFailure };
type RetryOptions = StreamOptions & { arxdRequest?: RequestIdentity };

export function safeRequestError(value: unknown, secrets: string[] = []): string {
  let text = value instanceof Error ? value.message : String(value ?? 'Unknown request failure');
  if (!text.trim()) text = 'Unknown request failure';
  for (const secret of secrets.filter((item) => item.length >= 3).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(authorization|api[-_ ]?key|access[-_ ]?token|password|secret)\s*["']?\s*[:=]\s*["']?[^\s,"'}]+(?:\s+[^\s,"'}]+)?/gi, '$1: [REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@');
  return text.length > 1000 ? text.slice(0, 970) + '… [diagnostic truncated]' : text;
}

/** Only this fetch/body boundary maps Expo 58 / OkHttp's concrete IOException
 * signals. Generic `fetch failed`, TypeError, parser and storage errors do not
 * establish connectivity failure. TLS trust/certificate errors are terminal. */
function transportCategory(error: unknown): RequestFailure['category'] {
  const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code;
  const text = typeof error === 'string' ? error : [e?.message, e?.cause?.message].filter(Boolean).join(': ');
  // This marker is generated only by ModelRequestPolicy at a native IOException
  // boundary. Expo 58 prefixes initial failures with fetch failed: and Android
  // may include java.io.IOException:. Preserve those observed wrappers only.
  // A TLS handshake wrapper alone proves neither a certificate failure nor a
  // retryable transport failure: inspect its typed cause, prioritizing trust.
  const native = /^(?:fetch failed:\s*)?(?:java\.io\.IOException:\s*)?Arxd model transport \[([A-Za-z0-9_.$,]{1,1024})\]:/.exec(text)?.[1].split(',') ?? [];
  if (native.some((type) => type.startsWith('java.security.cert.') || type.startsWith('javax.security.cert.') || type === 'javax.net.ssl.SSLPeerUnverifiedException') || /certificate|certpath|trust anchor|hostname.*verified|SSLPeerUnverifiedException|ERR_CERT|CERT_/i.test(text + code)) return 'certificate';
  if (native.includes('java.net.ProtocolException') || native.includes('javax.net.ssl.SSLProtocolException')) return 'protocol';
  if (native.includes('java.net.SocketTimeoutException')) return 'timeout';
  if (native.some((type) => ['java.io.EOFException', 'java.net.SocketException', 'java.net.ConnectException', 'java.net.NoRouteToHostException', 'java.net.UnknownHostException'].includes(type))) return 'network';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code ?? '')) return 'network';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (native.some((type) => type.startsWith('javax.net.ssl.')) || /\b(?:SSLException|SSLHandshakeException|SSLProtocolException)\b/.test(text)) return 'unknown';
  // Native OkHttp connect/DNS/socket/read messages, observed at Expo's native
  // fetch/response boundary only; never applied to provider's normalized prose.
  if (/Unable to resolve host|No address associated with hostname|Failed to connect to |Connection refused|Connection reset|Socket closed|Broken pipe|Network is unreachable|unexpected end of stream|software caused connection abort/i.test(text)) return 'network';
  if (/\b(?:connect|read|write|socket) timed out\b|\btimeout\b/i.test(text)) return 'timeout';
  return 'unknown';
}

export function retryableRequest(message: RetryMessage): boolean {
  return message.stopReason === 'error' && message.arxdFailure?.retryable === true && message.arxdFailure.attempt < 4 && Date.now() < message.arxdFailure.deadlineAt;
}

export function requestFailureMessage(model: Model<Api>, request: RequestIdentity, category: RequestFailure['category'], message: string): RetryMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: category === 'cancelled' ? 'aborted' : 'error', timestamp: Date.now(), errorMessage: safeRequestError(message),
    arxdFailure: { ...request, category, message: safeRequestError(message), retryable: category === 'network' || category === 'timeout' } };
}

/** One provider invocation is one send attempt. Pi owns durable retries. Each
 * closure captures its own fetch failure/status and timer; no shared last error. */
export function wrapRetryProvider<T extends Api>(provider: Provider<T>, defaultFetch?: typeof globalThis.fetch, resolveTimeout?: (model: Model<T>, options: RetryOptions) => number | undefined): Provider<T> {
  function run(model: Model<T>, options: RetryOptions | undefined, produce: (options: RetryOptions) => ReturnType<typeof createAssistantMessageEventStream>) {
    const request = options?.arxdRequest ?? { id: globalThis.crypto.randomUUID(), attempt: 1, stage: 'generation', deadlineAt: Date.now() + REQUEST_TOTAL_MS };
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    const transport = defaultFetch ?? options?.fetch ?? globalThis.fetch;
    const secrets = [options?.apiKey ?? '', ...Object.values(options?.headers ?? {}).filter((value): value is string => typeof value === 'string')];
    let failure: RequestFailure | undefined;
    let partial: AssistantMessage | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sdkSignals = new Map<AbortSignal, () => void>();
    const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener('abort', cancel); for (const [signal, listener] of sdkSignals) signal.removeEventListener('abort', listener); sdkSignals.clear(); };
    const fail = (category: RequestFailure['category'], message: string) => {
      if (settled) return;
      settled = true;
      const final = requestFailureMessage(model, request, category, message);
      if (failure && category === failure.category) final.arxdFailure = { ...failure, message: final.errorMessage! };
      if (partial) final.content = partial.content.filter((block) => block.type !== 'toolCall');
      output.push({ type: 'error', reason: final.stopReason as 'error' | 'aborted', error: final });
      output.end(); cleanup(); controller.abort();
    };
    const cancel = () => fail('cancelled', 'Request cancelled by user');
    options?.signal?.addEventListener('abort', cancel, { once: true });
    if (options?.signal?.aborted) { cancel(); return output; }
    if (Date.now() >= request.deadlineAt) { fail('budget', 'Request total deadline exhausted'); return output; }
    // Connection generation settings are applied inside the provider. Resolve its
    // deadline here too, before the guard and SDK start; never widen a caller's
    // lower deadline. The SDK's local controller still reaches native fetch.
    let configuredTimeout: number | undefined;
    try { configuredTimeout = resolveTimeout?.(model, options ?? {}); }
    catch { fail('configuration', 'Invalid model request timeout'); return output; }
    const deadlines = [options?.timeoutMs, configuredTimeout].filter((value): value is number => value !== undefined);
    if (deadlines.some((value) => !Number.isFinite(value) || value <= 0)) { fail('configuration', 'Invalid model request timeout'); return output; }
    const timeoutMs = Math.max(1, Math.floor(Math.min(REQUEST_TIMEOUT_MS, ...deadlines, request.deadlineAt - Date.now())));
    const attemptDeadlineAt = Date.now() + timeoutMs;
    const timedOut = () => fail(failure?.category === 'http' ? 'http' : 'timeout', failure?.category === 'http' ? failure.message : 'Model request deadline timed out');
    timer = setTimeout(timedOut, timeoutMs);
    const observe = (error: unknown) => {
      if (!controller.signal.aborted) {
        const category = transportCategory(error);
        failure = { ...request, category, message: safeRequestError(error, secrets), retryable: category === 'network' || category === 'timeout' };
      }
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      // Validate locally before entering the transport boundary.
      try {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint');
      } catch (error) { failure = { ...request, category: 'configuration', message: 'Invalid model endpoint', retryable: false }; throw error; }
      // OpenAI 7.19 / Anthropic 0.129 compose their own timeout controller.
      // Forward that signal into our controller instead of overwriting it. Keep
      // the listener until stream completion, including response-body reads.
      const sdkSignal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
      if (sdkSignal && sdkSignal !== controller.signal && !sdkSignals.has(sdkSignal)) {
        const abort = () => {
          if (settled || controller.signal.aborted) return;
          if (options?.signal?.aborted) cancel();
          else if (Date.now() >= attemptDeadlineAt) timedOut();
          else fail(failure?.category ?? 'unknown', failure?.message ?? 'Provider transport aborted before the configured deadline');
        };
        sdkSignals.set(sdkSignal, abort);
        sdkSignal.addEventListener('abort', abort, { once: true });
        if (sdkSignal.aborted) abort();
      }
      if (settled) throw new Error('Request already settled');
      let response: Response;
      try {
        const headers = new Headers(init?.headers); headers.set('X-Arxd-Model-Request', '1');
        headers.set('X-Arxd-Model-Deadline-At', String(attemptDeadlineAt));
        headers.set('X-Arxd-Model-Timeout-Ms', String(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, attemptDeadlineAt - Date.now()))));
        response = await transport(input, { ...init, headers, redirect: 'error', signal: controller.signal });
      }
      catch (error) { observe(error); throw error; }
      if (!response.ok) failure = { ...request, category: 'http', message: `HTTP ${response.status}`, retryable: false, status: response.status, ...(response.headers.get('x-request-id') ? { requestId: safeRequestError(response.headers.get('x-request-id')).slice(0, 160) } : {}) };
      if (!response.body || !response.ok) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          try { const value = await reader.read(); if (value.done) target.close(); else target.enqueue(value.value); }
          catch (error) { observe(error); target.error(error); }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      // Preserve Expo's native metadata and bound methods; only body reads are
      // decorated. Parsing remains in the provider and never implies networking.
      return new Proxy(response, { get(target, key) { if (key === 'body') return body; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
    };
    void (async () => {
      try {
        const upstream = produce({ ...options, fetch, signal: controller.signal, maxRetries: 0, timeoutMs });
        for await (const event of upstream) {
          if (settled) break;
          if (event.type !== 'done' && event.type !== 'error') { partial = event.partial; output.push(event); continue; }
          const message = (event.type === 'error' ? event.error : event.message) as RetryMessage;
          if (event.type === 'error') {
            const safe = safeRequestError(message.errorMessage?.trim() ? message.errorMessage : failure?.message ?? message.errorMessage, secrets);
            message.arxdFailure = failure ? { ...failure, message: safeRequestError(`${failure.status ? `HTTP ${failure.status}: ` : ''}${safe}`, secrets) } : { ...request, category: options?.signal?.aborted ? 'cancelled' : message.stopReason === 'aborted' ? 'unknown' : 'protocol', retryable: false, message: safe };
            const code = /["']code["']\s*:\s*["']([A-Za-z0-9_.-]{1,80})["']/.exec(safe)?.[1];
            if (code) message.arxdFailure.providerCode = code;
            message.errorMessage = message.arxdFailure.message;
            // SDK may label timeout as aborted; only explicit user stop is cancel.
            message.stopReason = message.arxdFailure.category === 'cancelled' ? 'aborted' : 'error';
            message.content = message.content.filter((block) => block.type !== 'toolCall');
            output.push({ type: 'error', reason: message.stopReason, error: message });
          } else output.push(event);
          settled = true; cleanup(); output.end();
        }
        if (!settled) fail('protocol', 'Model stream ended without terminal response');
      } catch (error) { if (!settled) fail(failure?.category ?? 'unknown', safeRequestError(error, secrets)); }
    })();
    return output;
  }
  return { ...provider,
    stream: ((model, context, options) => run(model, options, (next) => provider.stream(model, context, next as ApiStreamOptions<T>))) as Provider<T>['stream'],
    streamSimple: (model, context, options) => run(model, options, (next) => provider.streamSimple(model, context, next)),
  };
}
