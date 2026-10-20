import { apply } from '@earendil-works/chord/delta';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { SqliteDatabase, SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import { tr } from '../i18n/base.ts';

export type PendingDeletion = { id: ConversationId; error: string | null };
export async function openDeletionJournal(db: SqliteDatabase) {
  await db.exec('CREATE TABLE IF NOT EXISTS arxd_conversation_deletions (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, error TEXT) STRICT');
}
export function pendingDeletions(db: SqliteExecutor) { return db.all<PendingDeletion>('SELECT id, error FROM arxd_conversation_deletions ORDER BY started_at, id'); }
export async function deletingIds(db: SqliteExecutor) {
  const rows = await db.all<{ id: ConversationId }>('WITH RECURSIVE pending(id) AS (SELECT id FROM arxd_conversation_deletions UNION SELECT c.id FROM conversations c JOIN pending p ON c.owner_conversation_id = p.id) SELECT id FROM pending LIMIT 10001');
  if (rows.length > 10000) throw new Error('Deletion ownership inspection limit exceeded');
  return new Set(rows.map((row) => row.id));
}
export async function requireAvailable(db: SqliteExecutor, id: ConversationId) {
  if ((await deletingIds(db)).has(id)) throw new Error(tr('This conversation is being deleted. Retry from the cleanup notice.'));
}

/** Pinned Pi 1.3 schema only. Never guess how a future schema stores ownership. */
async function supported(db: SqliteExecutor) {
  if ((await db.get<{ version: number }>('SELECT version FROM durable_schema WHERE singleton = 1'))?.version !== 1) throw new Error(tr('Deletion does not support this storage version. Records are retained.'));
  const expected: Record<string, string> = {
    conversations: 'id,owner_conversation_id,owner_task_id,record', entries: 'id,conversation_id,head,commit_seq,record',
    tasks: 'id,conversation_id,kind,status,abort_requested,background,record', submissions: 'id,conversation_id,request_id,status,record',
    documents: 'id,kind,family,key_value,scope_kind,owner_id,created_at,retired_at,record', document_revisions: 'document_id,seq,kind,version,content',
    durable_metadata: 'singleton,next_id,next_seq', record_ids: 'id,record_type',
  };
  for (const [table, columns] of Object.entries(expected)) {
    if ((await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name).join(',') !== columns) throw new Error(tr('Deletion does not support this storage schema. Records are retained.'));
  }
}

/** Owned descendants belong to the deletion. Surviving forks must be deleted first. */
export async function deletionPlan(db: SqliteExecutor, id: ConversationId): Promise<ConversationId[]> {
  await supported(db);
  if (!Number.isSafeInteger(id) || id <= 1) throw new Error(tr('System conversations cannot be deleted.'));
  const rows = await db.all<{ id: ConversationId; record: string }>('SELECT id, record FROM conversations ORDER BY id LIMIT 10001');
  if (rows.length > 10000) throw new Error(tr('The conversation count exceeds the deletion inspection limit. Records are retained.'));
  const records = rows.map((row) => ({ id: row.id, ...JSON.parse(row.record) as { owner?: { conversationId: ConversationId }; parent?: { conversationId: ConversationId } } }));
  const root = records.find((row) => row.id === id);
  if (!root) return [];
  if (root.owner) throw new Error(tr('This conversation belongs to another task. Delete its owning conversation.'));
  const ids = new Set<ConversationId>([id]);
  let changed = true;
  while (changed) { changed = false; for (const row of records) if (row.owner && ids.has(row.owner.conversationId) && !ids.has(row.id)) { ids.add(row.id); changed = true; } }
  if (records.some((row) => !ids.has(row.id) && row.parent && ids.has(row.parent.conversationId))) throw new Error(tr('Other forks depend on this conversation. Delete those forks first.'));
  return [...ids];
}

/** Called only after the sole Harness has closed and joined every invocation. */
export async function eraseConversation(db: SqliteDatabase, id: ConversationId) {
  await db.transaction(async (tx) => {
    const ids = await deletionPlan(tx, id);
    await tx.exec('CREATE TEMP TABLE arxd_purge_conversations (id INTEGER PRIMARY KEY); CREATE TEMP TABLE arxd_purge_records (id INTEGER PRIMARY KEY)');
    for (const cid of ids) await tx.run('INSERT INTO arxd_purge_conversations VALUES (?)', cid);
    const inScope = '(SELECT id FROM arxd_purge_conversations)';
    if (await tx.get(`SELECT id FROM tasks WHERE conversation_id IN ${inScope} AND status != 'terminal' LIMIT 1`)) throw new Error(tr('Conversation tasks have not stopped. Retry deletion.'));
    if (await tx.get(`SELECT id FROM entries WHERE conversation_id NOT IN ${inScope} AND json_extract(record, '$.byTaskId') IN (SELECT id FROM tasks WHERE conversation_id IN ${inScope}) LIMIT 1`)) throw new Error(tr('Other records depend on this conversation. Records are retained.'));
    if (await tx.get(`SELECT id FROM tasks WHERE conversation_id NOT IN ${inScope} AND json_extract(record, '$.owner') IN (SELECT id FROM tasks WHERE conversation_id IN ${inScope}) LIMIT 1`)) throw new Error(tr('Other tasks depend on this conversation. Records are retained.'));
    await tx.exec(`INSERT INTO arxd_purge_records SELECT id FROM conversations WHERE id IN ${inScope};
      INSERT INTO arxd_purge_records SELECT id FROM entries WHERE conversation_id IN ${inScope};
      INSERT INTO arxd_purge_records SELECT id FROM tasks WHERE conversation_id IN ${inScope};
      INSERT INTO arxd_purge_records SELECT id FROM submissions WHERE conversation_id IN ${inScope};
      INSERT INTO arxd_purge_records SELECT id FROM documents WHERE (scope_kind = 'conversation' AND owner_id IN ${inScope}) OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id IN ${inScope}));`);
    // Session preferences may contain deltas. Materialize and replace only this
    // App-owned document; never rewrite arbitrary numeric values or task data.
    const prefs = await tx.all<{ id: number }>("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND retired_at IS NULL", JSON.stringify('arxd.preferences'));
    for (const doc of prefs) {
      const revisions = await tx.all<{ seq: number; kind: string; version: number; content: string }>('SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq', doc.id);
      const base = revisions.findLastIndex((row) => row.kind === 'base');
      if (base < 0 || revisions[base].version !== 1) throw new Error('Unsupported workspace preferences');
      let value = JSON.parse(revisions[base].content);
      for (const row of revisions.slice(base + 1)) { if (row.kind !== 'delta' || row.version !== 1) throw new Error('Unsupported workspace preferences revision'); value = apply(value, JSON.parse(row.content)); }
      if (!Array.isArray(value.conversations)) throw new Error('Invalid workspace preferences');
      value.conversations = value.conversations.filter((cid: ConversationId) => !ids.includes(cid) && cid !== id);
      if (ids.includes(value.active) || value.active === id) value.active = null;
      const sequence = (await tx.get<{ next_seq: number }>('SELECT next_seq FROM durable_metadata WHERE singleton = 1'))!.next_seq;
      await tx.run('DELETE FROM document_revisions WHERE document_id = ?', doc.id);
      await tx.run("INSERT INTO document_revisions VALUES (?, ?, 'base', 1, ?)", doc.id, sequence, JSON.stringify(value));
      await tx.run('UPDATE durable_metadata SET next_seq = ? WHERE singleton = 1', sequence + 1);
    }
    await tx.exec(`DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM arxd_purge_records);
      DELETE FROM documents WHERE id IN (SELECT id FROM arxd_purge_records);
      DELETE FROM submissions WHERE conversation_id IN ${inScope}; DELETE FROM entries WHERE conversation_id IN ${inScope};
      DELETE FROM tasks WHERE conversation_id IN ${inScope}; DELETE FROM conversations WHERE id IN ${inScope};
      DELETE FROM record_ids WHERE id IN (SELECT id FROM arxd_purge_records);`);
    await tx.run('DELETE FROM arxd_conversation_deletions WHERE id = ?', id);
    await tx.exec('DROP TABLE arxd_purge_records; DROP TABLE arxd_purge_conversations');
  });
}
