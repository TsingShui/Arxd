import { load, JSON_SCHEMA } from 'js-yaml';
import { tr } from '../i18n/base.ts';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { SkillDiscovery, SkillDiscovered, SkillResource, SkillSnapshot, SkillWorking } from '../../modules/rxd/index.ts';

export type SkillHost = {
  discover?(): Promise<SkillDiscovery>;
  rename?(id: string, name: string): Promise<void>;
  collect?(keep: string[]): Promise<void>;
  watch?(changed: () => void): () => void;
  importFile(id: string, uri: string): Promise<SkillWorking>;
  importArchive(id: string, uri: string): Promise<SkillWorking>;
  importWorkspace(id: string, path: string): Promise<SkillWorking>;
  importMarket?(id: string, files: string, source: string): Promise<SkillWorking>;
  working(id: string): Promise<SkillWorking>;
  write(id: string, text: string, expected: string): Promise<void>;
  snapshot(id: string, name: string, prune: boolean): Promise<SkillSnapshot>;
  read(id: string, name: string, version: string, path: string, expected: string, offset: number, limit: number): Promise<SkillResource>;
  remove(id: string): Promise<void>;
};
export type SkillMetadata = { name: string; description: string; compatibility?: string; license?: string; allowedTools?: string; metadata?: Record<string, string> };
export type SkillRecord = SkillMetadata & { id: string; path: string; version: string; enabled: boolean; status: 'active' | 'invalid' | 'removed' | 'deleting' | 'deleted'; source: string; error: string | null; updatedAt: number };
export type AdmittedSkill = Pick<SkillMetadata, 'name' | 'description'> & { id: string; version: string; selected: boolean };
type SkillRow = { id: string; metadata: string; path: string; version: string; enabled: number; status: SkillRecord['status']; source: string; error: string | null; updated_at: number; fingerprint?: string };
const decode = (row: SkillRow): SkillRecord => ({ ...JSON.parse(row.metadata), id: row.id, path: row.path, version: row.version, enabled: !!row.enabled, status: row.status, source: row.source, error: row.error, updatedAt: row.updated_at });

export function parseSkill(definition: string): SkillMetadata {
  if (new TextEncoder().encode(definition).length > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(definition)) throw new Error('SKILL.md 必须是 64 KiB 以内的 UTF-8 文本');
  const frontmatter = /^(?:\ufeff)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(definition);
  if (!frontmatter) throw new Error('SKILL.md 缺少 YAML frontmatter');
  const parsed = load(frontmatter[1], { schema: JSON_SCHEMA }) as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('技能元数据必须是映射');
  const { name, description } = parsed;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称须为 1–64 位小写字母、数字和单连字符');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) throw new Error('技能用途须为 1–1024 字符');
  const result: SkillMetadata = { name, description: description.trim() };
  for (const [source, target, limit] of [['compatibility', 'compatibility', 500], ['license', 'license', 1024], ['allowed-tools', 'allowedTools', 1024]] as const) {
    if (parsed[source] !== undefined) {
      if (typeof parsed[source] !== 'string' || !parsed[source].trim() || parsed[source].length > limit) throw new Error(`Invalid skill ${source}`);
      result[target] = parsed[source];
    }
  }
  if (parsed.metadata !== undefined) {
    if (!parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) throw new Error('Invalid skill metadata');
    const entries = Object.entries(parsed.metadata);
    if (entries.length > 100 || entries.some(([key, value]) => key.length > 100 || typeof value !== 'string' || value.length > 1024)) throw new Error('Invalid skill metadata values');
    result.metadata = Object.fromEntries(entries) as Record<string, string>;
    if (new TextEncoder().encode(JSON.stringify(result.metadata)).length > 16384) throw new Error('技能元数据超过 16 KiB');
  }
  return result;
}

/** Index and immutable published versions; working resources remain in the file manager. */
export class SkillLibrary {
  private readonly db: SqliteDatabase;
  private readonly host?: SkillHost;
  private discovery?: SkillDiscovery;
  private scanError: string | null = null;
  private listeners = new Set<() => void>();
  private reconciling: Promise<SkillRecord[]> | undefined;
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  scanStatus() { return { ...this.discovery, items: undefined, error: this.scanError }; }
  private notify() { for (const listener of this.listeners) listener(); }
  constructor(db: SqliteDatabase, host?: SkillHost) { this.db = db; this.host = host; }
  async open() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS arxd_skills_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS arxd_skills (id TEXT PRIMARY KEY,metadata TEXT NOT NULL,path TEXT NOT NULL,version TEXT NOT NULL,enabled INTEGER NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS arxd_skill_versions (id TEXT NOT NULL,version TEXT NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(id,version));`);
    const version = await this.db.get<{ value: string }>('SELECT value FROM arxd_skills_meta WHERE key = ?', 'version');
    if (version && !['1', '2'].includes(version.value)) throw new Error('Unsupported skill library schema');
    const columns = await this.db.all<{ name: string }>('PRAGMA table_info(arxd_skills)');
    if (!columns.some((column) => column.name === 'fingerprint')) await this.db.exec("ALTER TABLE arxd_skills ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
    await this.db.run('INSERT OR REPLACE INTO arxd_skills_meta (key,value) VALUES (?,?)', 'version', '2');
  }
  async list(query = '') {
    if (query.length > 1024) throw new Error('Skill query exceeds budget');
    const rows = await this.db.all<SkillRow>("SELECT * FROM arxd_skills WHERE status != 'deleted' ORDER BY updated_at DESC,id LIMIT 4097");
    if (rows.length > 4096) throw new Error('Skill catalog exceeds 4096 identities');
    const needle = query.trim().toLowerCase();
    return rows.map(decode).filter((skill) => !needle || `${skill.name}\n${skill.description}`.toLowerCase().includes(needle));
  }
  async get(id: string) {
    const row = await this.db.get<SkillRow>('SELECT * FROM arxd_skills WHERE id = ?', id);
    return row ? decode(row) : undefined;
  }
  async version(id: string, version: string) {
    const row = await this.db.get<{ snapshot: string }>('SELECT snapshot FROM arxd_skill_versions WHERE id = ? AND version = ?', id, version);
    if (!row) throw new Error('Admitted skill version is unavailable');
    return JSON.parse(row.snapshot) as SkillSnapshot;
  }
  private native() { if (!this.host) throw new Error('Skill host is unavailable'); return this.host; }
  private async install(origin: string, write: (host: SkillHost, id: string) => Promise<SkillWorking>) {
    if ((await this.list()).filter((row) => row.status !== 'removed').length >= 256) throw new Error('最多管理 256 个技能');
    const host = this.native(); const id = globalThis.crypto.randomUUID();
    try {
      const working = await write(host, id);
      const requested = parseSkill(working.definition);
      const snapshot = await host.snapshot(id, requested.name, false);
      const metadata = parseSkill(snapshot.definition);
      if (metadata.name !== requested.name) throw new Error('Skill changed during import');
      await this.db.transaction(async (tx) => {
        await tx.run('INSERT INTO arxd_skills (id,metadata,path,version,enabled,status,source,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, JSON.stringify(metadata), snapshot.workingPath, snapshot.version, 0, 'active', origin, Date.now());
        await tx.run('INSERT INTO arxd_skill_versions (id,version,snapshot) VALUES (?,?,?)', id, snapshot.version, JSON.stringify(snapshot));
      });
      this.notify();
      return (await this.get(id))!;
    } catch (error) { try { await host.remove(id); } catch { /* The original failure remains authoritative. */ } throw error; }
  }
  async import(kind: 'file' | 'workspace' | 'archive', source: string) {
    return this.install(kind, (host, id) => kind === 'file' ? host.importFile(id, source)
      : kind === 'archive' ? host.importArchive(id, source) : host.importWorkspace(id, source));
  }
  /** Marketplace bytes are data: validation already happened, admission is identical. */
  async importMarket(entry: { id: string; source: string; files: readonly { path: string; contents: string }[] }) {
    const host = this.native();
    if (!host.importMarket) throw new Error(tr('Unsupported'));
    const payload = JSON.stringify(entry.files);
    return this.install(`market:${entry.id}`, (activeHost, id) => activeHost.importMarket!(id, payload, entry.source));
  }
  async refresh(id: string, prune: boolean) {
    const record = await this.get(id);
    if (!record || record.status === 'deleted' || record.status === 'deleting') return record;
    try {
      const working = await this.native().working(id);
      const requested = parseSkill(working.definition);
      const snapshot = await this.native().snapshot(id, requested.name, false);
      const metadata = parseSkill(snapshot.definition);
      if (metadata.name !== requested.name) throw new Error('Skill changed during publication');
      await this.db.transaction(async (tx) => {
        await tx.run('INSERT OR REPLACE INTO arxd_skill_versions (id,version,snapshot) VALUES (?,?,?)', id, snapshot.version, JSON.stringify(snapshot));
        await tx.run('UPDATE arxd_skills SET metadata=?,path=?,version=?,status=?,error=NULL,updated_at=? WHERE id=?', JSON.stringify(metadata), snapshot.workingPath, snapshot.version, 'active', record.version === snapshot.version ? record.updatedAt : Date.now(), id);

      });
    } catch (error) { await this.db.run('UPDATE arxd_skills SET status=?,error=? WHERE id=?', 'invalid', String(error).slice(0, 800), id); }
    return this.get(id);
  }
  /** A complete native traversal is authoritative for removals; errors never imply absence. */
  async refreshAll(prune: boolean) {
    if (this.reconciling) return this.reconciling;
    const next = this.reconcile(prune);
    this.reconciling = next;
    try { const result = await next; this.scanError = null; return result; }
    catch (failure) { this.scanError = String(failure).slice(0, 800); this.notify(); throw failure; }
    finally { this.reconciling = undefined; }
  }
  private async reconcile(prune: boolean) {
    const host = this.native();
    if (!host.discover) {
      for (const row of await this.list()) if (row.status !== 'deleting') await this.refresh(row.id, false);
    } else {
      const discovered = await host.discover();
      if (!discovered.complete || discovered.items.length > 256) throw new Error('Incomplete shared skills scan; removals were not reconciled');
      this.discovery = discovered;
      const candidates = discovered.items.map((item) => {
        let metadata: SkillMetadata | undefined; let error = item.error;
        try { if (!error) metadata = parseSkill(item.definition); } catch (failure) { error = String(failure).slice(0, 800); }
        return { item, metadata, error };
      });
      const names = new Map<string, number>();
      for (const candidate of candidates) if (candidate.metadata) names.set(candidate.metadata.name, (names.get(candidate.metadata.name) ?? 0) + 1);
      for (const candidate of candidates) {
        if (candidate.metadata && names.get(candidate.metadata.name)! > 1) candidate.error = 'Conflicting skill name; rename the definition and directory explicitly';
        await this.publish(candidate.item, candidate.metadata, candidate.error);
      }
      const live = new Set(discovered.items.map((item) => item.id));
      // A failed/oversized traversal throws before reaching here, preserving unseen rows.
      for (const row of await this.list()) if (!live.has(row.id) && row.status !== 'deleting' && row.status !== 'removed') {
        await this.db.run("UPDATE arxd_skills SET status='removed',error=?,updated_at=? WHERE id=?", 'Skill directory was removed from the shared root', Date.now(), row.id);
      }
    }
    if (prune) await this.collect();
    this.notify();
    return this.list();
  }
  private async publish(item: SkillDiscovered, metadata: SkillMetadata | undefined, error: string | null) {
    const row = await this.db.get<SkillRow>('SELECT * FROM arxd_skills WHERE id=?', item.id);
    if (row?.status === 'deleting') return;
    // An App tombstone is revived only by a real, newly present live installation.
    if (!row) {
      const fallback = metadata ?? { name: item.folder.slice(0, 64), description: 'Pending or invalid shell installation' };
      await this.db.run('INSERT INTO arxd_skills (id,metadata,path,version,enabled,status,source,error,updated_at,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)', item.id, JSON.stringify(fallback), item.path, '', item.origin === 'app-import' ? 0 : 1, 'invalid', item.origin ?? 'shell', error, Date.now(), '');
    }
    if (error || !metadata) {
      await this.db.run("UPDATE arxd_skills SET status='invalid',path=?,error=?,fingerprint='' WHERE id=?", item.path, (error ?? 'Invalid skill metadata').slice(0, 800), item.id);
      return;
    }
    if (row?.status === 'active' && row.fingerprint === item.fingerprint && row.path === item.path) return;
    try {
      const snapshot = await this.native().snapshot(item.id, metadata.name, false);
      const current = parseSkill(snapshot.definition);
      if (current.name !== metadata.name) throw new Error('Skill changed during publication; retry after installation completes');
      await this.db.transaction(async (tx) => {
        await tx.run('INSERT OR REPLACE INTO arxd_skill_versions (id,version,snapshot) VALUES (?,?,?)', item.id, snapshot.version, JSON.stringify(snapshot));
        await tx.run("UPDATE arxd_skills SET metadata=?,path=?,version=?,status='active',error=NULL,fingerprint=?,updated_at=? WHERE id=?", JSON.stringify(current), snapshot.workingPath, snapshot.version, item.fingerprint, row?.version === snapshot.version ? row.updated_at : Date.now(), item.id);
      });
    } catch (failure) { await this.db.run("UPDATE arxd_skills SET status='invalid',error=?,fingerprint='' WHERE id=?", String(failure).slice(0, 800), item.id); }
  }
  /** Caller proves all submissions/tasks settled; recoverable pending work prevents collection. */
  private async collect() {
    if (!this.host?.collect) return;
    const rows = (await this.list()).filter((row) => ['active', 'invalid'].includes(row.status) && row.version);
    const keep = rows.map((row) => `${row.id}/${row.version}`);
    await this.host.collect(keep);
    const versions = await this.db.all<{ id: string; version: string }>('SELECT id,version FROM arxd_skill_versions LIMIT 8193');
    if (versions.length > 8192) throw new Error('Skill versions catalog exceeds cleanup budget');
    for (const version of versions) if (!keep.includes(`${version.id}/${version.version}`)) await this.db.run('DELETE FROM arxd_skill_versions WHERE id=? AND version=?', version.id, version.version);
  }
  async enabled(id: string, value: boolean) {
    const existing = await this.get(id);
    if (!existing || existing.status === 'deleted' || existing.status === 'deleting' || existing.status === 'removed') throw new Error('技能不可用');
    if (!value) { await this.db.run('UPDATE arxd_skills SET enabled=0 WHERE id=?', id); this.notify(); return (await this.get(id))!; }
    if (this.host?.discover) await this.refreshAll(false); else await this.refresh(id, false);
    const record = await this.get(id);
    if (!record || record.status !== 'active') throw new Error(record?.error ?? 'Skill is unavailable');
    await this.db.run('UPDATE arxd_skills SET enabled=? WHERE id=?', value ? 1 : 0, id);
    this.notify();
    return (await this.get(id))!;
  }
  async save(id: string, definition: string, expected: string) {
    const metadata = parseSkill(definition);
    const previous = await this.get(id);
    await this.native().write(id, definition, expected);
    if (previous && metadata.name !== previous.name) await this.native().rename?.(id, metadata.name);
    if (this.host?.discover) await this.refreshAll(false); else await this.refresh(id, false);
    const record = await this.get(id);
    if (record?.status !== 'active') throw new Error(record?.error ?? 'Skill update failed');
    return record;
  }
  working(id: string) { return this.native().working(id); }
  async remove(id: string) {
    const existing = await this.get(id);
    if (!existing || existing.status === 'deleted') return;
    await this.db.run('UPDATE arxd_skills SET status=?,enabled=0,error=NULL WHERE id=?', 'deleting', id);
    try {
      await this.native().remove(id);
      await this.db.transaction(async (tx) => { await tx.run('UPDATE arxd_skills SET status=? WHERE id=?', 'deleted', id); });
      this.notify();
    } catch (error) { await this.db.run('UPDATE arxd_skills SET error=? WHERE id=?', String(error).slice(0, 800), id); throw error; }
  }
  async resume() { for (const record of await this.list()) if (record.status === 'deleting') { try { await this.remove(record.id); } catch { /* Visible, retryable deletion. */ } } if (this.host?.discover) { try { await this.refreshAll(false); } catch (failure) { if (String(failure).includes('Unsupported')) throw failure; /* Visible scan diagnostic; task admission still requires a successful scan. */ } } }
  async prepare(selected: string[]): Promise<AdmittedSkill[]> {
    if (this.host?.discover) await this.refreshAll(false);
    const result: AdmittedSkill[] = [];
    for (const record of await this.list()) if (record.enabled && record.status === 'active') {
      const current = this.host?.discover ? record : await this.refresh(record.id, false);
      if (current?.status === 'active') {
        const { id, name, description, version } = current;
        result.push({ id, name, description, version, selected: selected.includes(id) });
      }
    }
    if (selected.some((id) => !result.some((skill) => skill.id === id))) throw new Error('已选技能已停用或不可用，请调整会话选择');
    this.notify();
    return result;
  }
  async resource(skill: AdmittedSkill, path: string, offset: number, limit: number) {
    const snapshot = await this.version(skill.id, skill.version);
    if (!path) return { kind: 'list', entries: snapshot.files.slice(offset, offset + 32), nextOffset: Math.min(snapshot.files.length, offset + 32), complete: offset + 32 >= snapshot.files.length };
    const file = snapshot.files.find((file) => file.path === path);
    if (!file) throw new Error('Resource is not part of the admitted skill');
    return this.native().read(skill.id, skill.name, skill.version, path, file.sha256, offset, limit);
  }
}
