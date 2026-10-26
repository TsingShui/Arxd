import '../runtime';
import { androidLocalModel } from '../agent/local-android';
import { agentSessions } from '../background/android';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openDatabaseAsync } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import Rxd from '../../modules/rxd';
import { ArxdSqlite } from '../agent/sqlite';
import { openWorkspace } from './core';
import { androidServices } from './native-services';
import { watchSharedSkills } from './shared-skills-watch';
import type { ConnectionSecret } from './connections';
import type { McpConfigStore } from './service-types';
import { oauthHost } from './oauth-host';
import { piAccounts } from './pi-account';

// Pre-connection-library installs stored the DeepSeek key here.
const legacyCredentialKey = 'arxd.deepseek.api-key';
const secretKey = (id: string) => { if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('Invalid connection identity'); return `arxd.connection.${id}`; };
const mcpConfig: McpConfigStore = {
  async read() {
    try {
      const preview = await Rxd.readFile('home', '.pi/agent/mcp.json');
      return preview.text === null || preview.sha256 === null ? null : { text: preview.text, sha256: preview.sha256 };
    } catch {
      return null;
    }
  },
  async write(text, expected) {
    for (const path of ['.pi', '.pi/agent']) await Rxd.createDirectory('home', path).catch(() => undefined);
    await Rxd.writeFile('home', '.pi/agent/mcp.json', text, expected);
    const preview = await Rxd.readFile('home', '.pi/agent/mcp.json');
    if (preview.sha256 === null) throw new Error('Pi MCP configuration was not written');
    return { sha256: preview.sha256 };
  },
  async readAuth() {
    try { const preview = await Rxd.readFile('home', '.pi/agent/mcp-auth.json'); return preview.text; } catch { return null; }
  },
  oauthSignIn: (name, url, settings) => oauthHost().signIn(name, url, settings),
  oauthToken: (name, url, settings) => oauthHost().token(name, url, settings),
  oauthSignOut: (name, url) => oauthHost().signOut(name, url),
};

const credentials = {
  async get(id: string): Promise<ConnectionSecret | undefined> {
    const saved = await SecureStore.getItemAsync(secretKey(id));
    if (saved) return JSON.parse(saved) as ConnectionSecret;
    if (id === 'deepseek') { const apiKey = await SecureStore.getItemAsync(legacyCredentialKey); if (apiKey) return { apiKey }; }
    return undefined;
  },
  async put(id: string, value: ConnectionSecret) { await SecureStore.setItemAsync(secretKey(id), JSON.stringify(value)); if (id === 'deepseek') await SecureStore.deleteItemAsync(legacyCredentialKey); },
  async remove(id: string) { if (id === 'deepseek') await SecureStore.deleteItemAsync(legacyCredentialKey); await SecureStore.deleteItemAsync(secretKey(id)); },
};

let opening: Promise<Awaited<ReturnType<typeof openWorkspace>>> | undefined;
export function getAndroidWorkspace() {
  opening ??= (async () => {
    const database = await openDatabaseAsync('arxd-workspace.sqlite');
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    const info = await Rxd.getInfo();
    const workspace = await openWorkspace(new ArxdSqlite(database), {
      localModel: androidLocalModel,
      services: androidServices,
      mcpConfig,
      diagnostic: (error) => {
        const e = error as { cause?: unknown; stack?: string };
        const message = `${String(error)} ${e?.cause ? String(e.cause) : ''}`.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1400);
        Rxd.report(JSON.stringify({ event: 'arxd-runtime-error', error: message, stack: e?.stack?.slice(0, 2600) }));
      },
      credentials,
      accounts: piAccounts(),
      live: { fetch: expoFetch as typeof globalThis.fetch },
      info, run: (input) => Rxd.runOutline(input.source, input.inputSha256, input.engineSha256),
      files: { save: (name, text) => Rxd.saveArtifact(name, text), capture: (root, path) => Rxd.captureFile(root, path), remove: (file) => Rxd.deleteCapture(file.uri, file.sha256) },
      skills: {
        rename: (id, name) => Rxd.renameSkill(id, name), discover: () => Rxd.discoverSkills(), collect: (keep) => Rxd.collectSkillVersions(keep), watch: watchSharedSkills,
        importFile: (id, uri) => Rxd.importSkillFile(id, uri), importArchive: (id, uri) => Rxd.importSkillArchive(id, uri), importWorkspace: (id, path) => Rxd.importSkillWorkspace(id, path),
        importMarket: (id, files, source) => Rxd.importSkillMarket(id, files, source),
        working: (id) => Rxd.readSkillWorking(id), write: (id, text, expected) => Rxd.writeSkillDefinition(id, text, expected), snapshot: (id, name, prune) => Rxd.snapshotSkill(id, name, prune),
        read: (id, name, version, path, expected, offset, limit) => Rxd.readSkillResource(id, name, version, path, expected, offset, limit), remove: (id) => Rxd.removeSkill(id),
      },
      shell: {
        run: (id, script, timeoutMs) => { const key = `workspace-${id}`; Rxd.registerShell(key); return Rxd.runShell(key, script, timeoutMs); },
        cancel: (id) => Rxd.cancelShell(`workspace-${id}`),
        progress: (id) => Rxd.shellProgress(`workspace-${id}`),
      },
    });
    const running = new Set(['send', 'editTurn', 'regenerate', 'compact']);
    const stop = async () => {
      const state = await workspace.harness.inspect(BACKGROUND_CONTEXT);
      const ids = new Set([...state.tasks.map((task) => task.record.conversationId), ...state.submissions.map((item) => item.conversationId)]);
      await Promise.all([...ids].map(async (id) => { await (await workspace.harness.conversation(id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT, { background: true }); }));
    };
    return new Proxy(workspace, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return running.has(String(key)) && typeof value === 'function'
        ? (...args: unknown[]) => agentSessions.run(async () => Reflect.apply(value, target, args), stop)
        : value;
    } });
  })();
  return opening;
}
