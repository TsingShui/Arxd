export type SessionHost = {
  enabled(): boolean;
  acquire(id: string): Promise<void>;
  release(id: string): void;
};

/** One lease per entire operation, not per screen or per native child process. */
export function sessionRunner(host: SessionHost, identity: () => string) {
  const stops = new Map<string, { stop(): Promise<unknown> | void; finished: Promise<void> }>();
  return {
    async run<T>(operation: () => Promise<T>, stop: () => Promise<unknown> | void): Promise<T> {
      if (!host.enabled()) return operation();
      const id = identity();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      stops.set(id, { stop, finished });
      try { await host.acquire(id); return await operation(); }
      finally { stops.delete(id); try { host.release(id); } finally { finish(); } }
    },
    async stop() {
      const owned = [...stops.values()];
      const results = await Promise.allSettled(owned.map(({ stop }) => Promise.resolve().then(stop)));
      // Keep Headless JS (and RN timers) alive until cancellation is durably
      // settled. Ending the task after merely posting abort can strand Pi.
      await Promise.all(owned.map(({ finished }) => finished));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
