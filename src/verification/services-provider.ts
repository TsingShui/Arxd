import type { JsonObject } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
export type ServiceProbeStep = { name: string | { ref: string }; args: Record<string, unknown>; allowError?: boolean };
export type ServiceProbePlan = { steps: ServiceProbeStep[] };
export type ServiceProbeObservation = { step: number; offered: string[]; results: { name: string; error: boolean }[] };
function offered(messages: readonly Message[]) {
  const names = new Set<string>();
  for (const message of messages) if (message.role === 'system') {
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
  }
  return [...names];
}
function resolve(value: unknown, results: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, results));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.ref === 'string' && Object.keys(object).length === 1) return object.ref.split('.').reduce<unknown>((current, part) => current !== null && current !== undefined ? (current as Record<string, unknown>)[part] : undefined, results);
    return Object.fromEntries(Object.entries(object).map(([name, entry]) => [name, resolve(entry, results)]));
  }
  return value;
}
/** Only controls a deterministic provider response. Pi, native processes and MCP remain real. */
export function servicesProbeProvider(observe: (value: ServiceProbeObservation) => void, checkpoint?: (step: number, signal?: AbortSignal) => Promise<void>) {
  const response: FauxResponseFactory = async (context, options) => {
    const user = context.messages.filter((message) => message.role === 'user').at(-1);
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const encoded = /<arxd-services-probe>([\s\S]*?)<\/arxd-services-probe>/.exec(text ?? '');
    if (!encoded) return fauxAssistantMessage(fauxText('Offline services verification; no live model request.'));
    const plan = JSON.parse(encoded[1]) as ServiceProbePlan;
    const from = context.messages.lastIndexOf(user!);
    const tools = context.messages.slice(from).filter((message) => message.role === 'toolResult');
    const outputs = tools.map((tool) => {
      try { return JSON.parse(tool.content.filter((block) => block.type === 'text').map((block) => block.text).join('')); }
      catch { return null; }
    });
    observe({ step: tools.length, offered: offered(context.messages), results: tools.map((tool) => ({ name: tool.toolName, error: tool.isError })) });
    await checkpoint?.(tools.length, options?.signal);
    if (tools.some((tool, i) => tool.isError && !plan.steps[i]?.allowError)) return fauxAssistantMessage(fauxText('OFFLINE_SERVICES_TOOL_ERROR'));
    const step = plan.steps[tools.length];
    if (!step) return fauxAssistantMessage(fauxText('OFFLINE_SERVICES_COMPLETE'));
    const name = typeof step.name === 'string' ? step.name : String(resolve(step.name, outputs));
    return fauxAssistantMessage(fauxToolCall(name, resolve(step.args, outputs) as JsonObject, { id: `services-probe-${user?.timestamp}-${tools.length}` }), { stopReason: 'toolUse' });
  };
  return response;
}
export const serviceProbePrompt = (steps: ServiceProbeStep[]) => `<arxd-services-probe>${JSON.stringify({ steps })}</arxd-services-probe>`;
