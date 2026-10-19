import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

// The same queue/transaction adapter is exercised with Expo SQLite on Android
// and node:sqlite in the host process-restart checks.
export interface NativeSqlite {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...values: (string | number | null | Uint8Array)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...values: (string | number | null | Uint8Array)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...values: (string | number | null | Uint8Array)[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

function bindings(values: SqliteValue[]) {
  return values.map((value) => {
    if (typeof value !== 'bigint') return value;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError('Expo SQLite cannot bind this bigint without precision loss');
    return number;
  });
}

export class ArxdSqlite implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly native: NativeSqlite;

  constructor(native: NativeSqlite) { this.native = native; }

  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.closed) throw new Error('SQLite storage is closed');
      return run();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private executor(active: () => boolean): SqliteExecutor {
    const check = () => {
      if (!active()) throw new Error('SQLite transaction handle has expired');
    };
    return {
      exec: async (sql) => { check(); await this.native.execAsync(sql); },
      run: async (sql, ...values) => { check(); await this.native.runAsync(sql, ...bindings(values)); },
      get: async <T extends object>(sql: string, ...values: SqliteValue[]) => {
        check();
        return (await this.native.getFirstAsync<T>(sql, ...bindings(values))) ?? undefined;
      },
      all: async <T extends object>(sql: string, ...values: SqliteValue[]) => {
        check();
        return this.native.getAllAsync<T>(sql, ...bindings(values));
      },
    };
  }

  exec(sql: string) { return this.queue(() => this.executor(() => true).exec(sql)); }
  run(sql: string, ...values: SqliteValue[]) { return this.queue(() => this.executor(() => true).run(sql, ...values)); }
  get<T extends object>(sql: string, ...values: SqliteValue[]) { return this.queue(() => this.executor(() => true).get<T>(sql, ...values)); }
  all<T extends object>(sql: string, ...values: SqliteValue[]) { return this.queue(() => this.executor(() => true).all<T>(sql, ...values)); }

  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      await this.native.execAsync('BEGIN IMMEDIATE');
      let active = true;
      const tx = this.executor(() => active);
      try {
        const value = await callback(tx);
        active = false;
        await this.native.execAsync('COMMIT');
        return value;
      } catch (error) {
        active = false;
        try { await this.native.execAsync('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'SQLite rollback failed'); }
        throw error;
      }
    });
  }

  close() {
    this.closing ??= this.queue(async () => {
      await this.native.closeAsync();
      this.closed = true;
    });
    return this.closing;
  }
}
