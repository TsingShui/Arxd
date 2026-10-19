import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { AssistantEntry, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { openAgentRuntime, type RxdHost } from '../agent/runtime.ts';

/** Durable checkpoint harness used only by the verification route and scripts. */
export async function openVerificationHarness(database: SqliteDatabase, host: RxdHost) {
  const { harness } = await openAgentRuntime(database, host);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });

  async function snapshot() {
    const entries = await conversation.entries({ order: 'ascending' }, 256, undefined, BACKGROUND_CONTEXT);
    if (entries.next) throw new Error('Verification transcript exceeds its 256-entry display limit');
    const tools = entries.items.filter(ToolResultEntry.is).map((entry) => entry.model?.[0] as ToolResultMessage);
    const answers = entries.items.filter(AssistantEntry.is).flatMap((entry) => entry.model ?? [])
      .filter((message): message is AssistantMessage => message.role === 'assistant' && message.stopReason === 'stop');
    return {
      conversationId: conversation.id,
      userCount: entries.items.filter(UserEntry.is).length,
      answerCount: answers.length,
      toolCount: tools.length,
      toolErrors: tools.filter((message) => message.isError).length,
      engine: host.info,
      tools: tools.map((message) => ({
        id: message.toolCallId,
        name: message.toolName,
        details: message.details,
        text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
      })),
      answer: answers.at(-1)?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '',
    };
  }

  return {
    harness,
    conversation,
    snapshot,
    async run(requestId: string, mode: 'rxd' | 'shell' = 'rxd') {
      if (mode === 'shell' && !host.shell) throw new Error('Shell host is unavailable');
      const submission = await conversation.submit({ type: 'input', content: mode === 'shell' ? '运行内置脚本环境验证。' : '分析内置 JavaScript 样本。', requestId }, BACKGROUND_CONTEXT);
      const outcome = await submission.wait(BACKGROUND_CONTEXT);
      if (outcome.status !== 'done') throw new Error(`Pi submission did not finish: ${JSON.stringify(outcome)}`);
      return snapshot();
    },
    async resume() {
      harness.resume();
      await harness.waitForIdle(BACKGROUND_CONTEXT);
      return snapshot();
    },
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}


export function waitForProcessKill(context: { abortSignal?: AbortSignal }): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (context.abortSignal?.aborted) return reject(new Error('Checkpoint aborted'));
    context.abortSignal?.addEventListener('abort', () => reject(new Error('Checkpoint aborted')), { once: true });
  });
}

export type VerificationSnapshot = Awaited<ReturnType<Awaited<ReturnType<typeof openVerificationHarness>>['snapshot']>>;
