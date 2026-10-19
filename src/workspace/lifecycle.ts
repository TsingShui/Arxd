import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from '@earendil-works/chord/context';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { RxdHost } from '../agent/runtime.ts';
import { tr } from '../i18n/base.ts';
import { openWorkspaceSession, type WorkspaceSession, type WorkspaceSnapshot } from './core.ts';
import { deletionPlan, eraseConversation, openDeletionJournal, pendingDeletions } from './deletions.ts';

/** Storage closes a lease; this controller alone owns the physical connection. */
function lease(db: SqliteDatabase): SqliteDatabase {
  let closed = false;
  const check = () => { if (closed) throw new Error('Workspace database lease is closed'); };
  return {
    exec: (sql) => { check(); return db.exec(sql); }, run: (sql, ...values) => { check(); return db.run(sql, ...values); },
    get: (sql, ...values) => { check(); return db.get(sql, ...values); }, all: (sql, ...values) => { check(); return db.all(sql, ...values); },
    transaction: (callback) => { check(); return db.transaction(callback); }, close: async () => { closed = true; },
  };
}
export type WorkspaceController = WorkspaceSession & { purge(id: ConversationId): Promise<WorkspaceSnapshot> };

export async function openWorkspaceController(db: SqliteDatabase, host: RxdHost): Promise<WorkspaceController> {
  await openDeletionJournal(db);
  async function beforeResume(harness: Harness) {
    // Mark every pending deletion before enabling dispatch after a crash. Even
    // when another conversation resumes, the deleted task can only abort.
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    for (const row of await pendingDeletions(db)) {
      const ids = await deletionPlan(db, row.id);
      for (const task of inspection.tasks) if (ids.includes(task.record.conversationId)) await harness.abortTask(task.record.id, BACKGROUND_CONTEXT);
      for (const submission of inspection.submissions) if (ids.includes(submission.conversationId)) await (await harness.submission(submission.id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
    }
  }
  const open = () => openWorkspaceSession(lease(db), host, beforeResume);
  let session: WorkspaceSession;
  try { session = await open(); } catch (error) { await db.close(); throw error; }
  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  const publish = (snapshot: WorkspaceSnapshot) => { for (const listener of listeners) listener(snapshot); };
  let unsubscribe = session.subscribe(publish);
  const inFlight = new Set<Promise<unknown>>();
  const controlInFlight = new Set<Promise<unknown>>();
  let maintenance: Promise<WorkspaceSnapshot> | undefined;
  let closed = false, failed = false;
  function invoke(action: () => unknown, control = false) {
    if (closed || failed) return Promise.reject(new Error(tr('工作区需要重新打开')));
    if (maintenance) return Promise.reject(new Error(tr('正在整理会话存储，请稍后重试')));
    const promise = Promise.resolve().then(action);
    inFlight.add(promise); if (control) controlInFlight.add(promise);
    const settled = () => { inFlight.delete(promise); controlInFlight.delete(promise); };
    void promise.then(settled, settled);
    return promise;
  }
  function purge(id: ConversationId): Promise<WorkspaceSnapshot> {
    if (closed || failed) return Promise.reject(new Error(tr('工作区需要重新打开')));
    if (maintenance) return Promise.reject(new Error(tr('正在整理会话存储，请稍后重试')));
    maintenance = (async () => {
      let journaled = false, sessionClosed = false, closingSession = false, replaced = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(tr('停止任务超时，请稍后重试删除'))), 20000);
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      try {
        const ids = await deletionPlan(db, id);
        await db.run('INSERT OR IGNORE INTO arxd_conversation_deletions (id, started_at, error) VALUES (?, ?, NULL)', id, Date.now());
        journaled = true;
        await session.refresh();
        for (const cid of ids) await (await session.harness.conversation(cid, BACKGROUND_CONTEXT))?.abort(context, { background: true });
        const inspection = await session.harness.inspect(BACKGROUND_CONTEXT);
        if (inspection.tasks.length || inspection.submissions.length) throw new Error(tr('其他会话仍在运行，结束后可重试删除'));
        await awaitWithContext(Promise.allSettled([...inFlight]), context);
        const remaining = await session.harness.inspect(BACKGROUND_CONTEXT);
        if (remaining.tasks.length || remaining.submissions.length) throw new Error(tr('其他会话仍在运行，结束后可重试删除'));
        unsubscribe(); unbindRelays();
        closingSession = true;
        await session.close(); sessionClosed = true; closingSession = false;
        try { await eraseConversation(db, id); }
        finally { session = await open(); sessionClosed = false; unsubscribe = session.subscribe(publish); bindRelays(); replaced = true; }
        publish(session.getSnapshot());
        return session.getSnapshot();
      } catch (error) {
        if (sessionClosed || closingSession) failed = true;
        if (journaled) await db.run('UPDATE arxd_conversation_deletions SET error = ? WHERE id = ?', String(error).slice(0, 500), id);
        if (!failed) await session.refresh();
        throw error;
      } finally { clearTimeout(timeout); maintenance = undefined; if (replaced && !closed && !failed) for (const relay of relays.values()) relay.notify(); }
    })();
    return maintenance;
  }
  // Stable manager identities resolve the current session at call time. A held
  // method must never keep the old MCP library/DB lease after a real purge.
  const groups = new Map<string, object>();
  type Relay = { path: string[]; listeners: Set<() => void>; off?: () => void; notify(): void };
  const relays = new Map<string, Relay>();
  function current(path: string[]): object {
    let value: unknown = session;
    for (const key of path) value = Reflect.get(value as object, key);
    if (!value || typeof value !== 'object') throw new Error('Workspace manager is unavailable');
    return value;
  }
  function checkSync() { if (closed || failed) throw new Error(tr('工作区需要重新打开')); }
  function unbindRelays() { for (const relay of relays.values()) { relay.off?.(); relay.off = undefined; } }
  function bindRelay(relay: Relay) {
    if (closed || failed || !relay.listeners.size || relay.off) return;
    const manager = current(relay.path);
    relay.off = Reflect.apply(Reflect.get(manager, 'subscribe'), manager, [relay.notify]) as () => void;
  }
  function bindRelays() { for (const relay of relays.values()) bindRelay(relay); }
  function subscribeManager(path: string[], listener: () => void) {
    checkSync(); const key = path.join('.');
    let relay = relays.get(key);
    if (!relay) {
      const listeners = new Set<() => void>();
      relay = { path, listeners, notify() { for (const item of [...listeners]) { try { item(); } catch (error) { host.diagnostic?.(error); } } } };
      relays.set(key, relay);
    }
    relay.listeners.add(listener); if (!maintenance) bindRelay(relay);
    return () => { relay.listeners.delete(listener); if (!relay.listeners.size) { relay.off?.(); relay.off = undefined; } };
  }
  const synchronous = new Set(['localModel.status', 'localModel.cancelDownload', 'connections.get', 'connections.catalog', 'connections.models', 'skills.scanStatus', 'services.processes.capabilities', 'services.processes.mcpCancel', 'services.processes.mcpHttpPolicy', 'services.mcp.httpPolicy']);
  const nested = new Set(['services.processes', 'services.mcp', 'services.processes.credentials']);
  function manager(path: string[]): object {
    const key = path.join('.'); const known = groups.get(key); if (known) return known;
    const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    const proxy = new Proxy({}, { get(_target, property) {
      if (property === 'then') return undefined;
      const value = Reflect.get(current(path), property), qualified = key + '.' + String(property);
      if (nested.has(qualified) && value) return manager([...path, String(property)]);
      if (typeof value !== 'function') { checkSync(); return value; }
      let method = methods.get(property);
      if (!method) {
        method = property === 'subscribe' && ['skills', 'services.mcp'].includes(key)
          ? (listener) => subscribeManager(path, listener as () => void)
          : (...args) => {
            const action = () => { const owner = current(path); return Reflect.apply(Reflect.get(owner, property), owner, args); };
            if (synchronous.has(qualified)) { checkSync(); return action(); }
            return invoke(action, true);
          };
        methods.set(property, method);
      }
      return method;
    } });
    groups.set(key, proxy); return proxy;
  }
  const controller = new Proxy({} as WorkspaceController, {
    get(_target, property) {
      if (property === 'purge') return purge;
      if (property === 'getSnapshot') return () => session.getSnapshot();
      // A report is a pure in-memory projection; UI render-time reads must not be dispatched.
      if (property === 'report') return (turnId: string) => session.report(turnId);
      if (property === 'subscribe') return (listener: (snapshot: WorkspaceSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
      if (property === 'close') return async () => {
        if (closed) return; closed = true; await maintenance?.catch(() => undefined);
        unsubscribe(); unbindRelays();
        // External manager operations may persist after a native await. Join
        // those before closing the DB lease; Harness.close still aborts sends.
        host.localModel?.cancelOperation();
        await Promise.allSettled([...controlInFlight]); await session.close();
        await Promise.allSettled([...inFlight]); await db.close();
        for (const relay of relays.values()) relay.listeners.clear(); listeners.clear();
      };
      const value = Reflect.get(session, property);
      if (['fileLibrary', 'skills', 'connections', 'services', 'localModel'].includes(String(property)) && value) return manager([String(property)]);
      if (typeof value === 'function') return (...args: unknown[]) => invoke(() => Reflect.apply(Reflect.get(session, property), session, args));
      return value;
    },
  });
  // Recovery is part of open. A pending cleanup stays visible/retryable if
  // unrelated recovered work is active; it never clears a failure silently.
  for (const row of await pendingDeletions(db)) { try { await purge(row.id); } catch (error) { host.diagnostic?.(error); } }
  return controller;
}
