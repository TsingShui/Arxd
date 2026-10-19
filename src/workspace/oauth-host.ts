import { Linking } from 'react-native';
import Rxd from '../../modules/rxd';
import type { McpOAuthSettings } from './service-types.ts';

type Pending = {
  resolve(value?: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Bridge to Pi's Node OAuth host. The host owns the loopback callback server
 * and mcp-auth.json; the App only opens the system browser and waits for the
 * completion event.
 */
export class OAuthHost {
  private readonly pending = new Map<string, Pending>();
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
    if (message.type === 'oauth-url' && typeof message.url === 'string') {
      const url = message.url;
      void Linking.openURL(url).catch((error) => {
        this.finish(requestId, error instanceof Error ? error : new Error(String(error)));
        this.send({ type: 'oauth-cancel', requestId });
      });
      return;
    }
    if (message.type === 'oauth-token') {
      this.finish(requestId, undefined, typeof message.token === 'string' ? message.token : undefined);
      return;
    }
    if (message.type === 'oauth-done') { this.finish(requestId); return; }
    if (message.type === 'oauth-cancelled') { this.finish(requestId, new Error('OAuth sign-in cancelled')); return; }
    if (message.type === 'oauth-error') { this.finish(requestId, new Error(typeof message.error === 'string' ? message.error : 'OAuth failed')); }
  }

  private finish(requestId: string, error?: Error, value?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private exited(code: number, stderr: string): void {
    this.starting = undefined;
    const error = new Error(`OAuth sidecar exited (${code})${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`);
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, error);
  }

  private request(message: Record<string, unknown>, timeoutMs: number): Promise<string | undefined> {
    return this.ensureStarted().then(() => new Promise<string | undefined>((resolve, reject) => {
      const requestId = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.finish(requestId, new Error('OAuth request timed out'));
        try { this.send({ type: 'oauth-cancel', requestId }); } catch { /* sidecar may be gone */ }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ ...message, requestId }); }
      catch (error) { this.finish(requestId, error instanceof Error ? error : new Error(String(error))); }
    }));
  }

  async signIn(name: string, url: string, settings: McpOAuthSettings): Promise<void> {
    await this.request({ type: 'oauth-signin', name, url, settings }, 300_000);
  }

  async token(name: string, url: string, settings: McpOAuthSettings): Promise<string | undefined> {
    return this.request({ type: 'oauth-token', name, url, settings }, 30_000);
  }

  async signOut(name: string, url: string): Promise<void> {
    try { this.send({ type: 'oauth-signout', name, url, requestId: globalThis.crypto.randomUUID() }); } catch { /* best effort */ }
  }
}

let shared: OAuthHost | undefined;
export function oauthHost(): OAuthHost { shared ??= new OAuthHost(); return shared; }
