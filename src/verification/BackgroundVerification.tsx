import '../runtime';
import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AppState, ScrollView, Text } from 'react-native';
import { openDatabaseAsync } from 'expo-sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ToolResultEntry } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import Rxd from '../../modules/rxd';
import { ArxdSqlite } from '../agent/sqlite';
import { openAgentRuntime } from '../agent/runtime';
import { agentSessions, enableBackground } from '../background/android';
import { ADB_INSTALL } from '../adb/termux';
import { requireVerification } from './access';

let active: Promise<unknown> | undefined;
export default function BackgroundVerification() {
  const params = useLocalSearchParams<{ action?: string; scriptHex?: string; request?: string }>();
  const [output, setOutput] = useState('OFFLINE DETERMINISTIC PROVIDER · not a live model');
  useEffect(() => {
    requireVerification();
    if (active) return;
    active = (async () => {
      const publish = async (stage: string, value: unknown) => {
        const report = { event: 'arxd-background-verification', stage, value, provider: 'offline-deterministic-not-live' };
        setOutput(JSON.stringify(report, null, 2));
        const data = JSON.stringify(report), messageId = globalThis.crypto.randomUUID();
        for (let index = 0; index * 1200 < data.length; index++) await Rxd.report(JSON.stringify({
          event: 'arxd-background-chunk', messageId, index, parts: Math.ceil(data.length / 1200), data: data.slice(index * 1200, (index + 1) * 1200),
        }));
      };
      await enableBackground(true);
      const action = params.action || 'run';
      if (action === 'install') {
        const id = 'background-install-' + globalThis.crypto.randomUUID(); Rxd.registerShell(id);
        await agentSessions.run(async () => {
          const result = await Rxd.runShell(id, ADB_INSTALL, 600000);
          await publish('install', result);
        }, () => Rxd.cancelShell(id)); return;
      }
      const database = await openDatabaseAsync('arxd-background-verification.sqlite');
      await database.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const runtime = await openAgentRuntime(new ArxdSqlite(database), {
        info: await Rxd.getInfo(),
        // This verifier only exercises shell; never fabricate an analysis result.
        ...{ run: async () => { throw new Error('Verification requires real shell execution'); } },
        offlineResponse: async (context) => {
          const user = context.messages.findLast((message) => message.role === 'user');
          const content = typeof user?.content === 'string' ? user.content : '';
          if (!content.startsWith('OFFLINE_BACKGROUND\n')) return undefined;
          const record = JSON.parse(content.slice('OFFLINE_BACKGROUND\n'.length));
          if (context.messages.slice(context.messages.lastIndexOf(user!) + 1).some((message) => message.role === 'toolResult')) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            return fauxAssistantMessage(fauxText('OFFLINE_BACKGROUND_COMPLETE · not a live model response'));
          }
          return fauxAssistantMessage(fauxToolCall('shell', { script: record.script, timeoutMs: 180000 }, { id: 'background-' + record.id }), { stopReason: 'toolUse' });
        },
        shell: {
          run: (id, script, timeout) => { Rxd.registerShell(id); void publish('shell-started', { id, script }); return Rxd.runShell(id, script, timeout); },
          cancel: (id) => Rxd.cancelShell(id),
        },
      });
      const { harness } = runtime;
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      try {
        await agentSessions.run(async () => {
          if (action === 'resume') { harness.resume(); await harness.waitForIdle(BACKGROUND_CONTEXT); }
          else {
            const hex = params.scriptHex;
            if (hex && (hex.length > 32768 || hex.length % 2 || !/^[0-9a-f]+$/.test(hex))) throw new Error('Invalid verification script encoding');
            const script = hex ? new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => parseInt(part, 16))) : 'id -u; adb version; sleep 8; printf "BACKGROUND_DONE\\n"';
            if (script.length > 16384) throw new Error('Verification script budget exceeded');
            const id = params.request || globalThis.crypto.randomUUID();
            const submission = await conversation.submit({ type: 'input', content: 'OFFLINE_BACKGROUND\n' + JSON.stringify({ script, id }), requestId: id }, BACKGROUND_CONTEXT);
            const outcome = await submission.wait(BACKGROUND_CONTEXT);
            await publish('outcome', outcome);
          }
          const entries = await conversation.entries({ order: 'ascending' }, 256, undefined, BACKGROUND_CONTEXT);
          const tools = entries.items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? []);
          await publish('complete', { conversationId: conversation.id, appState: AppState.currentState, tools });
        }, async () => { await conversation.abort(BACKGROUND_CONTEXT, { background: true }); });
      } finally { await harness.close(BACKGROUND_CONTEXT); await publish('closed', null); }
    })().catch(async (error) => {
      const report = { event: 'arxd-background-verification', stage: 'error', error: String(error), provider: 'offline-deterministic-not-live' };
      setOutput(JSON.stringify(report)); await Rxd.report(JSON.stringify(report));
    }).finally(() => { active = undefined; });
  }, [params.action, params.scriptHex, params.request]);
  return <ScrollView style={{ flex: 1, backgroundColor: '#141414', padding: 24 }}><Text style={{ color: '#eee' }}>{output}</Text></ScrollView>;
}
