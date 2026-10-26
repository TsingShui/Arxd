import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import type { Protocol } from '../workspace/connections';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import * as SecureStore from 'expo-secure-store';

/** Local deterministic HTTP fixtures; never sends conversation data or reads credential values. */
export async function verifyConnections(core: Workspace) {
  requireVerification();
  const checks: string[] = [];
  const ids: string[] = [];
  const captures: string[] = [];
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const original = core.getSnapshot();
  const legacy = (await core.connections.list()).find((row) => row.id === 'deepseek');
  assert(legacy?.endpoint === 'https://api.deepseek.com', 'Legacy DeepSeek endpoint and stable identity retained');
  assert(core.connections.models('deepseek').some((entry) => entry.id === 'deepseek' && entry.definition.id === 'deepseek-flash'), 'Legacy model and generation configuration migrated');
  try {
    for (const [protocol, path] of [['openai-completions', '/phone-completions'], ['openai-responses', '/responses'], ['anthropic-messages', '/anthropic'], ['google-generative-ai', '/google']] as [Protocol, string][]) {
      const connection = await core.connections.save({ name: `Arxd protocol probe ${protocol}`, preset: 'custom', protocol, endpoint: `http://127.0.0.1:17651${path}`, auth: 'key' });
      ids.push(connection.id);
      await core.connections.credential(connection.id, { apiKey: `arxd-fixture-${connection.id}`, headers: { 'X-Arxd-Probe': connection.id } });
      const entry = await core.connections.manual(connection.id, { id: 'probe-model', name: protocol, contextWindow: 128000, maxTokens: 4096, thinking: ['off'] }, { maxTokens: 96 }, true);
      const result = await core.connections.test(entry.id);
      assert(result.ok, protocol + ' streamed successfully: ' + (result.error ?? ''));
      await core.select(null); await core.model(entry.id); await core.send('Reply with the protocol fixture marker.');
      const last = core.getSnapshot().turns.at(-1);
      assert(last?.answer === 'MODEL_OK' && last.provider === connection.id, protocol + ' works through actual Android Pi and SQLite');
      const file = await Rxd.importSource('protocol-probe.js', 'export function fourProtocolToolProbe(value) { return value + 42; }');
      captures.push(file.id);
      await core.attach(file); await core.connections.updateModel(entry.id, { maxTokens: 512 }, true);
      await core.send('TOOL_ROUND_PROBE: actually query the attached file.', file.id);
      assert(core.getSnapshot().turns.at(-1)?.tools.some((tool) => tool.name === 'shell' && !tool.isError && tool.text.includes('fourProtocolToolProbe')), protocol + ' completes a real Android rxd shell round');
      await core.connections.remove(connection.id);
      assert(core.getSnapshot().turns.at(-1)?.answer === 'MODEL_OK', 'Removing connection preserves ' + protocol + ' history');
      assert((await core.fileLibrary.get(file.id))?.status === 'active', protocol + ' connection deletion retains the independent capture');
      let failed = false; try { await core.send('Deleted connection must fail before submission.'); } catch { failed = true; }
      assert(failed, 'Deleted connection rejected without switching to offline provider');
    }
    const small = await core.connections.save({ name: 'Arxd small context probe', preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:17651/small-phone', auth: 'none' });
    ids.push(small.id);
    const model = await core.connections.manual(small.id, { id: 'small-probe', name: 'Small probe', contextWindow: 8192, maxTokens: 1024, thinking: ['off'] }, { maxTokens: 64 }, true);
    await core.select(null); await core.model(model.id);
    for (let round = 0; round < 14; round++) {
      await core.send(`Small context round ${round}: ` + 'history '.repeat(205));
      const live = await core.harness.snapshot(LiveDoc, core.getSnapshot().active!, BACKGROUND_CONTEXT);
      for (const pending of live?.compactions ?? []) {
        const result = await core.harness.waitForTask(pending.taskId, BACKGROUND_CONTEXT);
        if (result.state.outcome.status === 'completed' && result.state.outcome.result.submissionId !== undefined) await (await core.harness.submission(result.state.outcome.result.submissionId, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
      }
      if (core.getSnapshot().turns.at(-1)?.answer !== 'MODEL_OK') throw new Error('Small model context or reply budget was exhausted');
    }
    const conversation = await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT);
    const entries = (await conversation!.entries({ order: 'ascending' }, 256, undefined, BACKGROUND_CONTEXT)).items;
    assert(entries.some((entry) => entry.kind === 'pi.compaction'), '8k model performs automatic compaction on native Hermes');
    assert(entries.filter((entry) => entry.kind === 'pi.user').length === 14, 'Small model compaction retains original messages');
    assert(core.getSnapshot().turns.length === 14, 'Small model retains replies and budgets across repeated HTTP requests');
    const broken = await core.connections.save({ name: 'Unreadable Credential Fixture', preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:17651/unused', auth: 'key' });
    // Only this probe-owned UUID is modified; never inspect or alter real keys.
    await SecureStore.setItemAsync(`arxd.connection.${broken.id}`, '{unreadable-fixture');
    assert((await core.connections.list()).some((row) => row.id === broken.id && row.credentialError), 'Unreadable credential is isolated from the workspace');
    assert(original.conversations.every((before) => core.getSnapshot().conversations.some((after) => before.id === after.id)), 'Credential failure retains existing conversations');
    Rxd.report(JSON.stringify({ event: 'arxd-connections', verified: true, checks, brokenConnection: broken.id, legacyHasCredential: !!legacy?.hasCredential, mode: 'deterministic-local-http/actual-android-providers' }));
  } finally {
    for (const id of ids) await core.connections.remove(id);
    for (const id of captures) await core.fileLibrary.remove(id);
    await core.select(null); await core.model(original.model); await core.thinking(original.thinking); await core.select(original.active);
  }
}
