import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeRemoteExchange,
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
} from '@earendil-works/pi-codemode/portable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import type { Registry } from '@earendil-works/pi-durable';
import Rxd from '../../modules/rxd';

type Execution = {
  exchange: CodemodeRemoteExchange;
  resolve(): void;
  reject(error: Error): void;
};

/**
 * Bridges Pi's RemoteCodemodeSandbox to the Termux Node sidecar.
 *
 * Hermes keeps the CodeMode host (tools, journal, output, deadlines). The
 * sidecar owns only the QuickJS VM. Every message is one JSON line; tool calls
 * come back through the same exchange and execute in this process.
 */
class NativeCodeModeRemote implements CodemodeRemote {
  private readonly executions = new Map<string, Execution>();
  private starting: Promise<void> | undefined;
  private readonly messages = Rxd.addListener('onCodeModeMessage', (payload) => this.receive(payload.line));
  private readonly exits = Rxd.addListener('onCodeModeExit', (info) => this.exited(info.code, info.stderr));
  private closed = false;

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error('CodeMode is closed');
    this.starting ??= Rxd.startCodeMode().then(
      () => undefined,
      (error) => {
        this.starting = undefined;
        throw error;
      },
    );
    return this.starting;
  }

  execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
    return this.ensureStarted().then(() => new Promise<void>((resolve, reject) => {
      const executionId = globalThis.crypto.randomUUID();
      this.executions.set(executionId, { exchange, resolve, reject });
      try {
        this.send({ type: 'execute', executionId, request });
      } catch (error) {
        this.executions.delete(executionId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }));
  }

  private send(message: unknown): void {
    Rxd.writeCodeMode(JSON.stringify(message));
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'exchange') {
      void this.exchange(message);
      return;
    }
    if (message.type === 'settled' && typeof message.executionId === 'string') {
      const execution = this.executions.get(message.executionId);
      if (!execution) return;
      this.executions.delete(message.executionId);
      execution.resolve();
      return;
    }
    if (message.type === 'failure' && typeof message.executionId === 'string') {
      const execution = this.executions.get(message.executionId);
      if (!execution) return;
      this.executions.delete(message.executionId);
      execution.reject(new Error(typeof message.error === 'string' ? message.error : 'CodeMode sandbox failed'));
    }
  }

  private async exchange(message: Record<string, unknown>): Promise<void> {
    const executionId = typeof message.executionId === 'string' ? message.executionId : '';
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const execution = this.executions.get(executionId);
    if (!execution) {
      this.send({ type: 'reply', requestId, reply: { type: 'stop' } });
      return;
    }
    let reply: CodemodeRemoteReply = null;
    try {
      reply = await execution.exchange(Array.isArray(message.messages) ? message.messages as CodemodeRemoteMessage[] : []);
    } catch {
      reply = { type: 'stop' };
    }
    try {
      this.send({ type: 'reply', requestId, reply });
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private exited(code: number, stderr: string): void {
    this.starting = undefined;
    this.failAll(new Error(`CodeMode sidecar exited (${code})${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`));
  }

  private failAll(error: Error): void {
    for (const execution of this.executions.values()) execution.reject(error);
    this.executions.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.messages.remove();
    this.exits.remove();
    this.failAll(new Error('CodeMode sandbox closed'));
    await Rxd.stopCodeMode().catch(() => undefined);
  }
}

let shared: NativeCodemodeSandbox | undefined;

/** One sidecar per app runtime; CodeMode calls are multiplexed by execution id. */
export class NativeCodemodeSandbox extends RemoteCodemodeSandbox {
  private readonly bridge: NativeCodeModeRemote;
  constructor(bridge: NativeCodeModeRemote) {
    super({ remote: () => bridge, timeoutMs: 300_000, memoryLimitBytes: 128 * 1024 * 1024 });
    this.bridge = bridge;
  }

  override async close(): Promise<void> {
    await this.bridge.close();
    await super.close();
  }
}

export function nativeCodemodeSandbox(): NativeCodemodeSandbox {
  shared ??= new NativeCodemodeSandbox(new NativeCodeModeRemote());
  return shared;
}

/** Install Pi's durable CodeMode tool; scripts call the conversation's callable tools. */
export function installCodemode(registry: Registry): void {
  registry.install(createCodemodeExtension({ sandbox: nativeCodemodeSandbox(), models: false }));
}
