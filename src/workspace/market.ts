import { tr } from '../i18n/base.ts';

/** Public catalog endpoints published by skills.sh. No token, no telemetry. */
export const MARKET_ORIGIN = 'https://skills.sh';
const SEARCH_LIMIT = 40;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type MarketSearchItem = { id: string; name: string; source: string; installs: number; url: string };
export type MarketFile = { path: string; contents: string };
export type MarketSkill = { id: string; source: string; files: MarketFile[]; marketHash: string | null };

const fail = (message: string, vars?: Record<string, string | number>) => { throw new Error(tr(message, vars)); };
const idPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,3}$/;

export function marketId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !idPattern.test(value) || value.split('/').some((part) => part === '.' || part === '..')) fail('Bad id');
  return value as string;
}

/** Catalog entries are untrusted input: drop anything that is not a plain record. */
export function parseMarketSearch(payload: unknown): MarketSearchItem[] {
  const candidate = (payload as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(candidate)) fail('Bad response');
  const rows = candidate as unknown[];
  const seen = new Set<string>();
  const items: MarketSearchItem[] = [];
  for (const row of rows.slice(0, SEARCH_LIMIT * 4)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    let id: string;
    try { id = marketId(entry.id); } catch { continue; }
    if (seen.has(id)) continue;
    const source = entry.source === undefined ? id.split('/').slice(0, -1).join('/') : entry.source;
    if (typeof source !== 'string' || !source.length || source.length > 200) continue;
    const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 120 ? entry.name.trim() : id.split('/').at(-1)!;
    const installs = typeof entry.installs === 'number' && Number.isFinite(entry.installs) && entry.installs >= 0 && entry.installs <= 1e12 ? Math.floor(entry.installs) : 0;
    seen.add(id);
    items.push({ id, name, source, installs, url: `https://skills.sh/${id}` });
    if (items.length >= SEARCH_LIMIT) break;
  }
  return items;
}

function marketPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.length || value.length > 400 || value.startsWith('/') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.length < 1 || parts.length > 16) return null;
  for (const part of parts) {
    if (!part.length || part === '.' || part === '..' || part.length > 128) return null;
    if (/[\u0000-\u001f\u007f]/.test(part)) return null;
  }
  if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store') return null;
  return parts.join('/');
}

/** A registry payload becomes a bounded, flat file list before anything is written. */
export function parseMarketSkill(payload: unknown, id: string): MarketSkill {
  const record = payload as { files?: unknown; hash?: unknown };
  if (!record || typeof record !== 'object' || !Array.isArray(record.files)) fail('No files');
  const rows: MarketFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const row of (record.files as unknown[]).slice(0, MAX_FILES * 2)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const path = marketPath(entry.path);
    if (!path || seen.has(path)) continue;
    if (typeof entry.contents !== 'string') fail('Not text');
    const size = new TextEncoder().encode(entry.contents as string).length;
    if (size > MAX_FILE_BYTES) fail('File too big');
    total += size;
    if (total > MAX_TOTAL_BYTES) fail('Too big');
    seen.add(path);
    rows.push({ path, contents: entry.contents as string });
  }
  if (!rows.length || rows.length > MAX_FILES) fail('Too many files');
  const files = unwrap(rows);
  if (!files.some((file) => file.path === 'SKILL.md')) fail('No SKILL.md');
  return {
    id: marketId(id),
    source: id.split('/').slice(0, -1).join('/'),
    files,
    marketHash: typeof record.hash === 'string' && /^[a-f0-9]{64}$/.test(record.hash) ? record.hash : null,
  };
}

/** Some publishers wrap the skill in one directory; the pinned layout stays flat. */
function unwrap(files: MarketFile[]): MarketFile[] {
  if (files.some((file) => file.path === 'SKILL.md')) return files;
  const roots = new Set(files.map((file) => file.path.split('/')[0]));
  if (roots.size !== 1) return files;
  const prefix = `${[...roots][0]}/`;
  if (!files.every((file) => file.path.startsWith(prefix))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

async function readJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) fail('HTTP {status}', { status: String(response.status) });
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > RESPONSE_LIMIT) fail('Response too big');
  const text = await response.text();
  if (text.length > RESPONSE_LIMIT) fail('Response too big');
  try { return JSON.parse(text) as unknown; } catch { return fail('Bad JSON'); }
}

export async function searchMarket(query: string, signal?: AbortSignal) {
  const text = query.trim().slice(0, 200);
  if (text.length < 2) return [] as MarketSearchItem[];
  return parseMarketSearch(await readJson(`${MARKET_ORIGIN}/api/search?q=${encodeURIComponent(text)}&limit=${SEARCH_LIMIT}`, signal));
}

export async function fetchMarketSkill(id: string, signal?: AbortSignal) {
  return parseMarketSkill(await readJson(`${MARKET_ORIGIN}/api/download/${marketId(id).split('/').map(encodeURIComponent).join('/')}`, signal), id);
}
