import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { Cursor } from '@earendil-works/pi-durable';
import type { FileRoot, WorkspaceFile } from '../../modules/rxd/index.ts';
import { MAX_IMPORT_BYTES } from './limits.ts';

export type FileHost = {
  save(name: string, text: string): Promise<WorkspaceFile>;
  capture(root: FileRoot, path: string): Promise<WorkspaceFile>;
  remove(file: WorkspaceFile): Promise<void>;
};
export type LibraryFile = { file: WorkspaceFile; origin: 'import' | 'generated'; status: 'active' | 'deleting' | 'deleted'; createdAt: number; error: string | null };
type Row = { metadata: string; origin: LibraryFile['origin']; status: LibraryFile['status']; created_at: number; error: string | null };
const decode = (row: Row): LibraryFile => ({ file: JSON.parse(row.metadata), origin: row.origin, status: row.status, createdAt: row.created_at, error: row.error });

/** App-owned tables; independent of Pi conversation records and lifecycle. */
export class FileLibrary {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) { this.db = db; }
  async open() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS arxd_files_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS arxd_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL, origin TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT, artifact_id TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS arxd_files_order ON arxd_files(status, created_at DESC, id);`);
    const version = await this.db.get<{ value: string }>('SELECT value FROM arxd_files_meta WHERE key = ?', 'version');
    if (version && version.value !== '1') throw new Error('Unsupported file library schema');
    await this.db.run('INSERT OR IGNORE INTO arxd_files_meta (key, value) VALUES (?, ?)', 'version', '1');
  }
  async get(id: string) {
    const row = await this.db.get<Row>('SELECT * FROM arxd_files WHERE id = ?', id);
    return row ? decode(row) : undefined;
  }
  async artifact(id: string) {
    const row = await this.db.get<Row>("SELECT * FROM arxd_files WHERE artifact_id = ? AND status != 'deleted'", id);
    return row ? decode(row) : undefined;
  }
  async register(file: WorkspaceFile, origin: LibraryFile['origin'] = 'import', artifact?: string, migration = false) {
    file = { ...file }; delete file.available;
    if (!/^[a-f0-9-]{1,128}$/.test(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_IMPORT_BYTES) throw new Error('Invalid captured file identity');
    if (!file.name || file.name.length > 240 || file.uri.length > 4096 || (file.source !== null && new TextEncoder().encode(file.source).length > 4096)) throw new Error('Captured file metadata exceeds budget');
    return this.db.transaction(async (tx) => {
      const old = await tx.get<Row>('SELECT * FROM arxd_files WHERE id = ?', file.id);
      if (old) {
        const record = decode(old);
        if (record.file.sha256 !== file.sha256 || record.file.size !== file.size || record.file.uri !== file.uri) throw new Error('Captured file identity conflict');
        if (record.status !== 'active' && !migration) throw new Error('文件已删除或正在删除');
        return record.file;
      }
      await tx.run('INSERT INTO arxd_files (id,name,metadata,origin,status,created_at,artifact_id) VALUES (?,?,?,?,?,?,?)', file.id, file.name, JSON.stringify(file), origin, 'active', Date.now(), artifact ?? null);
      return file;
    });
  }
  async list(query = '', offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 240) throw new Error('Invalid file query');
    const pattern = '%' + query.trim().replace(/[\\%_]/g, (value) => '\\' + value) + '%';
    const rows = await this.db.all<Row>("SELECT * FROM arxd_files WHERE status != 'deleted' AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC,id LIMIT 201 OFFSET ?", pattern, offset);
    return { files: rows.slice(0, 200).map(decode), nextOffset: rows.length > 200 ? offset + 200 : null };
  }
  async rename(id: string, name: string) {
    name = name.trim();
    if (!name || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('请输入有效的文件名');
    const record = await this.get(id);
    if (!record || record.status !== 'active') throw new Error('文件已删除或正在删除');
    const file = { ...record.file, name };
    await this.db.run('UPDATE arxd_files SET name = ?, metadata = ? WHERE id = ? AND status = ?', name, JSON.stringify(file), id, 'active');
    return file;
  }
  async remove(id: string, host: FileHost) {
    const record = await this.get(id);
    if (!record || record.status === 'deleted') return;
    await this.db.run('UPDATE arxd_files SET status = ?, error = NULL WHERE id = ?', 'deleting', id);
    try {
      await host.remove(record.file);
      await this.db.run('UPDATE arxd_files SET status = ?, error = NULL, artifact_id = NULL WHERE id = ?', 'deleted', id);
    } catch (error) {
      await this.db.run('UPDATE arxd_files SET error = ? WHERE id = ?', String(error).slice(0, 500), id);
      throw error;
    }
  }
  async resume(host?: FileHost) {
    if (!host) return;
    const rows = await this.db.all<{ id: string }>('SELECT id FROM arxd_files WHERE status = ? ORDER BY id LIMIT 100', 'deleting');
    for (const row of rows) { try { await this.remove(row.id, host); } catch { /* Retained as a visible retryable deletion. */ } }
  }
  async migration(): Promise<{ done: boolean; cursor?: Cursor }> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM arxd_files_meta WHERE key = ?', 'migration');
    return row ? JSON.parse(row.value) as { done: boolean; cursor?: Cursor } : { done: false };
  }
  async migrated(cursor?: Cursor) {
    await this.db.run('INSERT OR REPLACE INTO arxd_files_meta (key,value) VALUES (?,?)', 'migration', JSON.stringify(cursor ? { done: false, cursor } : { done: true }));
  }
}
