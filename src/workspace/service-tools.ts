import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { McpLibrary } from './services-library.ts';
import type { ProcessLaunch, ServiceHost } from './service-types.ts';

export const SERVICE_TOOLS = ['process_start', 'process_definitions', 'process_definition', 'process_definition_remove', 'process_list', 'process_inspect', 'process_logs', 'process_input', 'process_stop', 'process_remove'];
const Id = () => Type.String({ pattern: '^[a-f0-9-]{36}$' });
const DefinitionId = () => Type.String({ pattern: '^svc-v1-[a-f0-9]{64}$' });
const Definition = () => Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), script: Type.Optional(Type.String({ maxLength: 65536 })),
  argv: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 128 })),
  identity: Type.Union([Type.Literal('app'), Type.Literal('root')]), cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  endpoints: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 8 })),
  environment: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })) });
const limits = { maxBytes: 196608, maxLines: 2048, retain: 'head' as const };
const result = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }] });

/** All side-effecting admissions remain unsafe to replay; process lifetime is independent of tool lifetime. */
export function serviceExtension(host: ServiceHost, mcp: McpLibrary) {
  return defineExtension({ name: 'arxd-services', tools: [
    defineTool({ name: 'process_start', description: 'Start an explicitly requested trusted long-running service and return immediately with its handle. Select app/root identity. It remains alive across turns and chat Stop; stop it explicitly. Never execute analyzed samples. Do not repeat an uncertain start. A full launch returns a content-bound definitionId; explicitly pass only definitionId to launch another execution of that immutable saved configuration.',
      parameters: Type.Object({ ...Type.Partial(Definition()).properties, definitionId: Type.Optional(DefinitionId()) }), replay: 'unsafe', executionMode: 'sequential', outputLimits: limits,
      execute: async (request, api, context) => {
        if (context.abortSignal?.aborted) throw new Error('Process admission canceled before dispatch');
        return result(await host.start(`pi/${mcp.scope}/${api.conversationId}/${api.taskId}`, { ...request, origin: `conversation:${api.conversationId}/task:${api.taskId}` } as ProcessLaunch));
      } }),
    defineTool({ name: 'process_definitions', description: 'List retained immutable launch definitions, distinct from execution instances. No process is started. A definition survives removal of exited execution records; explicitly remove an unused definition to reclaim its bounded slot.',
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }),
      replay: 'safe', outputLimits: limits, execute: async ({ offset = 0, limit = 16 }) => result(await host.definitions(offset, limit)) }),
    defineTool({ name: 'process_definition', description: 'Inspect one content-bound v1 service definition; environment values stay private. process_start with definitionId explicitly creates a new execution using the original complete configuration.',
      parameters: Type.Object({ id: DefinitionId() }), replay: 'safe', outputLimits: limits, execute: async ({ id }) => result(await host.definition(id)) }),
    defineTool({ name: 'process_definition_remove', description: 'Explicitly remove an unused saved service definition. Retained execution records must be removed first. Does not stop or start processes.',
      parameters: Type.Object({ id: DefinitionId() }), replay: 'unsafe', outputLimits: limits, execute: async ({ id }) => { await host.removeDefinition(id); return result({ removed: id }); } }),
    defineTool({ name: 'process_list', description: 'List workspace-owned process instances shared by all conversations. Running does not mean application-ready. No process is restarted by inspection.',
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }),
      replay: 'safe', outputLimits: limits, execute: async ({ offset = 0, limit = 16 }) => result(await host.list(offset, limit)) }),
    defineTool({ name: 'process_inspect', description: 'Inspect one stable process instance, requested/observed identity, lifecycle and failure reason. Lost ownership is not proof the OS process died.',
      parameters: Type.Object({ id: Id() }), replay: 'safe', outputLimits: limits, execute: async ({ id }) => result(await host.inspect(id)) }),
    defineTool({ name: 'process_logs', description: 'Read retained byte-cursor stdout/stderr logs. Cursor -1 reads the latest page. Follow nextCursor for new bytes; droppedBytes identifies gaps. MCP stdout belongs to its protocol broker, not logs.',
      parameters: Type.Object({ id: Id(), stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]), cursor: Type.Optional(Type.Integer({ minimum: -1 })), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 49152 })) }),
      replay: 'safe', outputLimits: limits, execute: async ({ id, stream, cursor = -1, maxBytes = 8192 }) => {
        const page = await host.logs(id, stream, cursor, maxBytes);
        const { base64, ...metadata } = page;
        return result(page.text !== null && page.text !== undefined ? metadata : { ...metadata, base64, textUnavailable: 'Page is binary or crosses UTF-8 byte boundaries; base64 preserves exact bytes' });
      } }),
    defineTool({ name: 'process_input', description: 'Write up to 16KiB UTF-8 to a running ordinary process, optionally closing stdin. Delivery is not command completion. MCP-owned stdin rejects raw writes. Never automatically repeat uncertain input.',
      parameters: Type.Object({ id: Id(), text: Type.String({ maxLength: 16384 }), close: Type.Optional(Type.Boolean()) }), replay: 'unsafe', executionMode: 'sequential', outputLimits: limits,
      execute: async ({ id, text, close = false }, _api, context) => {
        if (context.abortSignal?.aborted) throw new Error('Process input canceled before dispatch');
        if (new TextEncoder().encode(text).length > 16384) throw new Error('Stdin write exceeds 16 KiB');
        await host.write(id, text, close); return result({ id, delivered: true, commandCompletion: false });
      } }),
    defineTool({ name: 'process_stop', description: 'Explicitly stop the verified owned process group, escalating within finite bounds. A failed/unknown outcome is not success; the process is never automatically restarted.',
      parameters: Type.Object({ id: Id() }), replay: 'unsafe', executionMode: 'sequential', outputLimits: limits, execute: async ({ id }) => result(await host.stop(id)) }),
    defineTool({ name: 'process_remove', description: 'Remove an exited, verified process record and retained logs. Stop a live/unknown instance explicitly first. This does not delete workspace files.',
      parameters: Type.Object({ id: Id() }), replay: 'unsafe', executionMode: 'sequential', outputLimits: limits, execute: async ({ id }) => { await host.remove(id); return result({ id, removed: true }); } }),
  ] });
}
