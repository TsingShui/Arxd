import Rxd from '../../modules/rxd';
import { localRevision, PINNED_MODEL_ID } from '../agent/local-provider';
import { androidLocalModel } from '../agent/local-android';
import type { Workspace } from '../workspace/core';
import { requireVerification } from './access';

const EVENT: Record<string, string> = {
  'ui-local-download': 'arxd-local-download',
  'ui-local-stage': 'arxd-local-download',
  'ui-local-import': 'arxd-local-import',
  'ui-local-remove': 'arxd-local-remove',
  'ui-local-release': 'arxd-local-release',
};

/** Runs the real installed GGUF through the product workspace, not faux or a canned tool call. */
export async function verifyLocalModel(core: Workspace, action: string) {
  requireVerification();
  try { await runLocalModel(core, action); }
  catch (error) {
    Rxd.report(JSON.stringify({ event: EVENT[action] ?? 'arxd-local-result', action, verified: false, error: String(error).slice(0, 1000) }));
    throw error;
  }
}

async function runLocalModel(core: Workspace, action: string) {
  const started = Date.now();
  if (!core.localModel) throw new Error('On-device model host unavailable');
  if (action === 'ui-local-download' || action === 'ui-local-stage') {
    const cached = core.localModel.status().models.some((model) => model.id === PINNED_MODEL_ID);
    if (action === 'ui-local-stage') await Rxd.stageLocalModelFixture();
    else await core.localModel.download();
    const record = core.localModel.status().models.find((model) => model.id === PINNED_MODEL_ID);
    Rxd.report(JSON.stringify({ event: 'arxd-local-download', action, transport: action === 'ui-local-stage' ? 'adb-pinned-fixture' : cached ? 'cached-ready' : 'https', verified: !!record?.available, durationMs: Date.now() - started, revision: record && localRevision(record) }));
    return;
  }
  if (action === 'ui-local-import') {
    // Fixed, hash-checked ADB fixture fed through the real import + probe path.
    const record = await core.localModel.import(`file://${Rxd.localModelFixturePath()}`, 'Qwen3.5-2B-Q4_K_M.gguf');
    Rxd.report(JSON.stringify({ event: 'arxd-local-import', action, transport: 'adb-fixture-import', verified: record.available, durationMs: Date.now() - started, id: record.id, name: record.name, bytes: record.bytes, sha256: record.sha256, contextWindow: record.contextWindow, maxTokens: record.maxTokens, revision: localRevision(record) }));
    return;
  }
  if (action === 'ui-local-remove') {
    if (core.localModel.status().models.some((model) => model.id === PINNED_MODEL_ID)) await core.localModel.remove(PINNED_MODEL_ID);
    Rxd.report(JSON.stringify({ event: 'arxd-local-remove', action, verified: !core.localModel.status().models.some((model) => model.id === PINNED_MODEL_ID) }));
    return;
  }
  if (action === 'ui-local-release') {
    await androidLocalModel.release();
    const status = core.localModel.status();
    Rxd.report(JSON.stringify({ event: 'arxd-local-release', action, verified: !status.loaded && !status.busy })); return;
  }
  if (action === 'ui-local-cancel') {
    // No tools: test native decoding interruption, not a model-chosen shell task.
    await androidLocalModel.release();
    const record = core.localModel.status().models.find((model) => model.available);
    if (!record) throw new Error('No installed on-device model to cancel');
    const abort = new AbortController(); let stopAt = 0, sawContent = false, failure = '';
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      await androidLocalModel.generate(record.id, { messages: [{ role: 'user', content: '请依次列出从1到1000的整数，每行一个数字。' }], tools: [], maxTokens: 1024, thinking: false }, abort.signal, () => undefined, (content) => {
        if (content.trim() && !abort.signal.aborted) { sawContent = true; stopAt = Date.now(); abort.abort(); }
      });
    } catch (error) { failure = String(error); }
    finally { clearTimeout(timer); }
    const status = core.localModel.status();
    const verified = sawContent && abort.signal.aborted && /cancelled/.test(failure) && !status.loaded && !status.busy;
    Rxd.report(JSON.stringify({ event: 'arxd-local-result', action, kind: 'cancel', scope: 'native-abort-signal', model: record.id, verified, stopMs: stopAt ? Date.now() - stopAt : undefined, failure }));
    await androidLocalModel.release();
    return;
  }
  await core.stop(); // Only the isolated verifier's previously interrupted turn.
  await core.select(null);
  const choices = core.getSnapshot().models.filter((choice) => choice.offline && choice.available);
  // Import verification runs with the pinned entry removed; prefer the imported
  // content id when both exist so the run proves the imported record.
  const choice = choices.find((entry) => entry.id !== PINNED_MODEL_ID) ?? choices[0];
  if (!choice) throw new Error('No installed on-device model');
  const thinkingRun = action === 'ui-local-thinking';
  await core.model(choice.id);
  await core.thinking(thinkingRun && choice.thinking.includes('medium') ? 'medium' : 'off');
  const record = core.localModel.status().models.find((model) => model.id === choice.id);
  const file = await Rxd.importSource(`local-${globalThis.crypto.randomUUID()}.js`, 'export function addTax(price) { return price * 1.08; }\n');
  await core.attach(file);
  await core.send('请调用 rxd_file_outline 检查这个 JavaScript 文件，报告发现的函数名。必须依据工具结果作答。', file.id);
  const snapshot = await core.refresh(); const turn = snapshot.turns.at(-1);
  const tools = turn?.activities.filter((entry) => entry.kind === 'tool') ?? [];
  const reasoning = (turn?.activities.filter((entry) => entry.kind === 'thinking') ?? []).map((entry) => entry.text ?? '').join('\n').trim();
  const verified = turn?.status === 'done' && tools.some((tool) => tool.state === 'done' && tool.result && !tool.result.isError && tool.result.text.includes('addTax')) && !!turn.answer.includes('addTax') && !turn.answer.includes('<think>') && (!thinkingRun || reasoning.length > 0);
  Rxd.report(JSON.stringify({ event: 'arxd-local-result', action, kind: thinkingRun ? 'thinking' : 'plain', verified, modelChoice: choice.id, thinkingLevel: core.localModel.status().models.find((model) => model.id === choice.id)?.thinking ? (thinkingRun ? 'medium' : 'off') : 'off', thinkingChars: reasoning.length, thinkingPreview: reasoning.slice(0, 256), revision: record && localRevision(record), durationMs: Date.now() - started, turnStatus: turn?.status, answer: turn?.answer.slice(0, 512), errors: turn?.requestErrors, tools: tools.map((tool) => ({ name: tool.name, state: tool.state, isError: tool.result?.isError, output: tool.result?.text.slice(0, 768) })), status: core.localModel.status(), fileSha256: file.sha256 }));
  if (!verified) throw new Error('Real on-device tool loop did not pass');
}
