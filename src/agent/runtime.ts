import type { LocalModelHost } from './local-provider.ts';
import { arxdSmallContextPolicy } from './small-context-policy.cjs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { McpConfigStore, ServiceHost } from '../workspace/service-types.ts';
import { type LiveConnection } from './types.ts';
import { createRegistry, defineExtension, Harness, DEFAULT_COMPACTION_POLICY, type HarnessSettings } from '@earendil-works/pi-durable';
import { SqliteStorage, type SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { shellTool, type ShellHost } from './shell.ts';
import type { FileHost } from '../workspace/files.ts';
import type { ConnectionHost } from '../workspace/connections.ts';
import { ConnectionLibrary } from '../workspace/connections.ts';
import type { PiAccountHost } from '../workspace/pi-account.ts';
import { installCodemode } from './codemode.ts';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { capacityVerificationProvider } from '../verification/capacity-provider.ts';
import { createOfflineProvider, offlineExtension, type OfflineHost } from './offline-provider.ts';

export type RxdHost = OfflineHost & {
  localModel?: LocalModelHost;
  services?: ServiceHost;
  mcpConfig?: McpConfigStore;
  shell?: ShellHost;
  live?: LiveConnection;
  diagnostic?(error: unknown): void;
  files?: FileHost;
  credentials?: ConnectionHost;
  accounts?: PiAccountHost;
};

export async function openAgentRuntime(database: SqliteDatabase, host: RxdHost) {
  // Models/provider factories are per-workspace; stable API metadata makes
  // persisted offline request provenance comparable after process recovery.
  const provider = createOfflineProvider(host);
  const connections = new ConnectionLibrary(database, host.credentials, host.live?.fetch, host.live?.getKey, host.accounts, host.localModel);
  await connections.open();
  const models = connections.models;
  models.setProvider(capacityVerificationProvider(provider.provider));

  const registry = createRegistry();
  registry.install(offlineExtension(host));
  registry.install(defineExtension({
    name: 'arxd-runtime',
    tools: host.shell ? [shellTool(host.shell)] : [],
  }));

  installCodemode(registry);
  registry.install(createToolSearchExtension());

  const settings: HarnessSettings = { stream: { timeoutMs: 90000, maxRetries: 0 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxAgentDelayMs: 4000 }, progress: { partialIntervalMs: 100, outputIntervalMs: 100 } };
  const storage = await SqliteStorage.open(database);
  const harness = await Harness.open(storage, {
    models,
    registry,
    onReport: (error) => host.diagnostic?.(new Error(connections.redact(error))),
    settings,
  }, BACKGROUND_CONTEXT);
  const getCompactionPolicy = (contextWindow = 0) => arxdSmallContextPolicy({ ...DEFAULT_COMPACTION_POLICY, ...settings.compaction }, contextWindow);
  return { harness, registry, connections, models, getCompactionPolicy };
}
