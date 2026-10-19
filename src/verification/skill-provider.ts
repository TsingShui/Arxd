import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';

let pause: (() => Promise<void>) | undefined;
/** Only the explicit offline verification action installs this provider boundary gate. */
export function holdSkillRead(checkpoint?: () => Promise<void>) { pause = checkpoint; }
export async function skillVerificationResponse(context: Parameters<FauxResponseFactory>[0]) {
  const lastUser = context.messages.filter((message) => message.role === 'user').at(-1);
  const user = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
  const marker = /<arxd-shared-skills-probe name="([a-z0-9-]+)"\/>/.exec(user ?? '');
  if (!marker) return undefined;
  const start = context.messages.lastIndexOf(lastUser!);
  const results = context.messages.slice(start).filter((message) => message.role === 'toolResult');
  const last = results.at(-1);
  if (!last) return fauxAssistantMessage(fauxToolCall('skill_search', { query: marker[1] }, { id: 'shared-search' }), { stopReason: 'toolUse' });
  if (last.isError) return fauxAssistantMessage(fauxText('OFFLINE_SHARED_SKILL_ERROR'));
  const parsed = JSON.parse(last.content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
  if (last.toolName === 'skill_search') {
    const skill = parsed.skills.find((item: { name: string }) => item.name === marker[1]);
    return skill ? fauxAssistantMessage(fauxToolCall('skill_load', { id: skill.id, version: skill.version }, { id: 'shared-load' }), { stopReason: 'toolUse' }) : fauxAssistantMessage(fauxText('OFFLINE_SHARED_SKILL_UNAVAILABLE'));
  }
  if (last.toolName === 'skill_load') {
    await pause?.();
    return fauxAssistantMessage(fauxToolCall('skill_read', { id: parsed.id, version: parsed.version, path: 'references/guide.md' }, { id: 'shared-read' }), { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage(fauxText(`OFFLINE_SHARED_SKILL_RESOURCE: ${parsed.text}`));
}
