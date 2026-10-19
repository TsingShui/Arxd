import Rxd from '../../modules/rxd';

export type PiAccountProvider = 'openai-codex' | 'kimi-coding' | 'xai';
export type PiAccountCredential = { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
export type PiAccountStatus = { signedIn: boolean; expires?: number; accountId?: string };

export type PiAccountEvent =
  | { type: 'device-code'; userCode: string; verificationUri: string; instructions?: string; expiresInSeconds?: number; intervalSeconds?: number }
  | { type: 'auth-url'; url: string; instructions?: string }
  | { type: 'progress'; message: string };

type Pending = {
  resolve(value?: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  event?: (event: PiAccountEvent) => void;
};

/**
 * Bridge to Pi's account OAuth flows in the Termux Node sidecar.
 *
 * The sidecar owns Pi's auth.json and token refresh; this class only carries
 * device-code/authorization-link events to the UI and exposes short-lived
 * request credentials to the connection provider.
 */
export class PiAccountHost {
  private readonly pending = new Map<string, Pending>();
  private readonly logins = new Map<PiAccountProvider, string>();
  private starting: Promise<void> | undefined;
  private readonly messages = Rxd.addListener('onCodeModeMessage', (payload) => this.receive(payload.line));
  private readonly exits = Rxd.addListener('onCodeModeExit', (info) => this.exited(info.code, info.stderr));

  private async ensureStarted(): Promise<void> {
    this.starting ??= Rxd.startCodeMode().then(
      () => undefined,
      (error) => { this.starting = undefined; throw error; },
    );
    return this.starting;
  }

  private send(message: unknown): void { Rxd.writeCodeMode(JSON.stringify(message)); }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (message.type === 'pi-device-code' && typeof message.userCode === 'string' && typeof message.verificationUri === 'string') {
      pending.event?.({ type: 'device-code', userCode: message.userCode, verificationUri: message.verificationUri,
        ...(typeof message.instructions === 'string' ? { instructions: message.instructions } : {}),
        ...(typeof message.expiresInSeconds === 'number' ? { expiresInSeconds: message.expiresInSeconds } : {}),
        ...(typeof message.intervalSeconds === 'number' ? { intervalSeconds: message.intervalSeconds } : {}) });
      return;
    }
    if (message.type === 'pi-auth-url' && typeof message.url === 'string') {
      pending.event?.({ type: 'auth-url', url: message.url, ...(typeof message.instructions === 'string' ? { instructions: message.instructions } : {}) });
      return;
    }
    if (message.type === 'pi-progress' && typeof message.message === 'string') {
      pending.event?.({ type: 'progress', message: message.message });
      return;
    }
    if (message.type === 'pi-token') {
      const token = message.token;
      this.finish(requestId, undefined, token && typeof token === 'object' && !Array.isArray(token) ? token : undefined);
      return;
    }
    if (message.type === 'pi-status') {
      const status = message.status;
      this.finish(requestId, undefined, status && typeof status === 'object' && !Array.isArray(status) ? status : undefined);
      return;
    }
    if (message.type === 'pi-done') { this.finish(requestId); return; }
    if (message.type === 'pi-cancelled') { this.finish(requestId, new Error('账号登录已取消')); return; }
    if (message.type === 'pi-error') { this.finish(requestId, new Error(typeof message.error === 'string' ? message.error : '账号登录失败')); }
  }

  private finish(requestId: string, error?: Error, value?: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private exited(code: number, stderr: string): void {
    this.starting = undefined;
    const error = new Error(`账号 sidecar 已退出（${code}）${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`);
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, error);
    this.logins.clear();
  }

  private invoke(requestId: string, message: Record<string, unknown>, timeoutMs: number, event?: (event: PiAccountEvent) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(requestId, new Error('账号请求超时'));
        try { this.send({ type: 'pi-cancel', requestId }); } catch { /* sidecar may be gone */ }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, event });
      try { this.send({ ...message, requestId }); }
      catch (error) { this.finish(requestId, error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private request(message: Record<string, unknown>, timeoutMs: number, event?: (event: PiAccountEvent) => void): Promise<unknown> {
    return this.ensureStarted().then(() => this.invoke(globalThis.crypto.randomUUID(), message, timeoutMs, event));
  }

  async login(provider: PiAccountProvider, onEvent?: (event: PiAccountEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.logins.has(provider)) throw new Error('此账号正在登录');
    await this.ensureStarted();
    const requestId = globalThis.crypto.randomUUID();
    this.logins.set(provider, requestId);
    const request = this.invoke(requestId, { type: 'pi-login', provider, method: 'device_code' }, 15 * 60_000, onEvent);
    const cancel = () => this.cancel(provider);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await request;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.logins.get(provider) === requestId) this.logins.delete(provider);
    }
  }

  cancel(provider: PiAccountProvider): void {
    const requestId = this.logins.get(provider);
    if (!requestId) return;
    this.logins.delete(provider);
    try { this.send({ type: 'pi-cancel', requestId }); } catch { /* sidecar may be gone */ }
  }

  async token(provider: PiAccountProvider): Promise<PiAccountCredential | undefined> {
    const value = await this.request({ type: 'pi-token', provider }, 30_000);
    return value as PiAccountCredential | undefined;
  }

  async status(provider: PiAccountProvider): Promise<PiAccountStatus> {
    const value = await this.request({ type: 'pi-status', provider }, 10_000);
    return (value as PiAccountStatus | undefined) ?? { signedIn: false };
  }

  async logout(provider: PiAccountProvider): Promise<void> {
    await this.request({ type: 'pi-logout', provider }, 10_000);
  }
}

let shared: PiAccountHost | undefined;
export function piAccounts(): PiAccountHost { shared ??= new PiAccountHost(); return shared; }
