import { requireNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { McpState, ProcessLog, ProcessPage, ProcessRecord, ServiceHost } from './service-types.ts';

export const NativeServices = requireNativeModule<{
  definitions(offset: number, limit: number): Promise<string>; definition(id: string): Promise<string>; removeDefinition(id: string): Promise<void>;
  mcpHttpPolicy(): string; mcpSetHttpPolicy(allowed: boolean): Promise<string>;
  capabilities(): string; notificationsAllowed(): boolean;
  start(admission: string, request: string): Promise<string>; list(offset: number, limit: number): Promise<string>;
  inspect(id: string): Promise<string>; inspectOptional(id: string): Promise<string>; logs(id: string, stream: string, cursor: number, limit: number): Promise<string>;
  write(id: string, encoded: string, close: boolean): Promise<string>; stop(id: string): Promise<string>; remove(id: string): Promise<void>;
  verifyHttpPolicy(host: string): string; verifyHttpPolicyCommitFailure(): Promise<string>;
  verifyLaunchPersistenceFailure(): Promise<string>; verifyInterruptedStop(id: string): Promise<string>;
  fixture(name: string): Promise<string>; mcpConnect(config: string): Promise<string>;
  mcpRequest(server: string, invocation: string, method: string, params: string, timeout: number): Promise<string>;
  mcpRequestBound(server: string, connectionId: string, toolsRevision: number, invocation: string, method: string, params: string, timeout: number): Promise<string>;
  mcpPublishCatalog(server: string, connectionId: string, revision: number, catalogId: string): Promise<string>;
  mcpRequestCatalogBound(server: string, connectionId: string, revision: number, catalogId: string, invocation: string, method: string, params: string, timeout: number): Promise<string>;
  mcpCancel(invocation: string): void; mcpEnabled(server: string, enabled: boolean): Promise<string>;
  mcpDisconnect(server: string): Promise<string>; mcpStates(): Promise<string>;
}>('ArxdServices');
function encode(text: string) { const data = new TextEncoder().encode(text); if (data.length > 16384) throw new Error('Stdin exceeds 16 KiB'); let value = ''; for (const byte of data) value += String.fromCharCode(byte); return globalThis.btoa(value); }
function key(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid MCP credential identity'); return `arxd.mcp.${id}.headers`; }

export const androidServices: ServiceHost = {
  mcpHttpPolicy: () => JSON.parse(NativeServices.mcpHttpPolicy()),
  mcpSetHttpPolicy: async (allowed) => JSON.parse(await NativeServices.mcpSetHttpPolicy(allowed)),
  definitions: async (offset = 0, limit = 16) => JSON.parse(await NativeServices.definitions(offset, limit)),
  definition: async (id) => JSON.parse(await NativeServices.definition(id)),
  removeDefinition: (id) => NativeServices.removeDefinition(id),
  capabilities: () => JSON.parse(NativeServices.capabilities()) as Record<string, unknown>,
  start: async (admission, request) => {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && !NativeServices.notificationsAllowed()) {
      const allowed = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (allowed !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Enable Arxd notifications to start a visible long-running service');
    }
    return JSON.parse(await NativeServices.start(admission, JSON.stringify(request))) as ProcessRecord;
  },
  list: async (offset = 0, limit = 16) => JSON.parse(await NativeServices.list(offset, limit)) as ProcessPage,
  inspect: async (id) => {
    const result = JSON.parse(await NativeServices.inspectOptional(id)) as { found: boolean; code?: string; record?: ProcessRecord };
    if (!result.found) {
      if (result.code !== 'ERR_MANAGED_PROCESS_NOT_FOUND') throw new Error('Invalid process inspection result');
      throw Object.assign(new Error('Unknown process instance'), { code: result.code });
    }
    if (!result.record) throw new Error('Invalid process inspection result');
    return result.record;
  },
  logs: async (id, stream, cursor, limit) => JSON.parse(await NativeServices.logs(id, stream, cursor, limit)) as ProcessLog,
  write: async (id, text, close = false) => { await NativeServices.write(id, encode(text), close); },
  stop: async (id) => JSON.parse(await NativeServices.stop(id)) as ProcessRecord,
  remove: (id) => NativeServices.remove(id),
  mcpConnect: async (config) => JSON.parse(await NativeServices.mcpConnect(JSON.stringify(config))) as McpState,
  mcpRequest: async (server, invocation, method, params, timeout) => JSON.parse(await NativeServices.mcpRequest(server, invocation, method, JSON.stringify(params), timeout)) as unknown,
  mcpPublishCatalog: async (server, connectionId, revision, catalogId) => JSON.parse(await NativeServices.mcpPublishCatalog(server, connectionId, revision, catalogId)) as McpState,
  mcpRequestBound: async (server, connectionId, toolsRevision, invocation, method, params, timeout, catalogId) => JSON.parse(await (catalogId
    ? NativeServices.mcpRequestCatalogBound(server, connectionId, toolsRevision, catalogId, invocation, method, JSON.stringify(params), timeout)
    : NativeServices.mcpRequestBound(server, connectionId, toolsRevision, invocation, method, JSON.stringify(params), timeout))) as unknown,
  mcpCancel: (invocation) => NativeServices.mcpCancel(invocation),
  mcpEnabled: async (server, enabled) => JSON.parse(await NativeServices.mcpEnabled(server, enabled)) as McpState,
  mcpDisconnect: async (server) => JSON.parse(await NativeServices.mcpDisconnect(server)) as McpState,
  mcpStates: async () => JSON.parse(await NativeServices.mcpStates()) as McpState[],
  credentials: { get: async (id) => await SecureStore.getItemAsync(key(id)) ?? undefined,
    set: (id, value) => SecureStore.setItemAsync(key(id), value), remove: (id) => SecureStore.deleteItemAsync(key(id)) },
};
