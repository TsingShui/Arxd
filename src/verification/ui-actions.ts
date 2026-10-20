import { requireVerification } from './access';
import { verifyLocalModel } from './local-model';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import Rxd from '../../modules/rxd';
import { SAMPLE_SOURCE } from '../agent/offline-provider';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import { reportUiStage } from './report';
import { verifyContextCapacity, reopenContextCapacity } from './context-capacity';
import { prepareCapacityUi, inspectCapacityUi, prepareCapacityManualUi, releaseCapacityUiSummary, prepareCapacityBusyUi, releaseCapacityBusyUi, cleanupCapacityUi } from './context-capacity-ui';
import { verifyFiles } from './files';
import { verifySkills } from './skills';
import { verifySharedSkills, verifySharedSkillsReopen, stageSharedSkillsRestart, stagePendingSharedSkill, recoverPendingSharedSkill } from './shared-skills';
import { verifyConnections } from './connections';
import { enableThemeReporting } from '../ui/appearance';
import { verifyAppearanceWork } from './appearance';
import { verifyArchive } from './archive';
import { verifyDeletion } from './deletion';
import { verifyPreferences } from './preferences';

/**
 * Deep-link automation the UI verification scripts drive (`arxd:///?action=ui-*`).
 * It lives here so the production screen carries no harness code; every branch
 * still goes through the public workspace API and reports what really happened.
 */
export async function runUiAction(
  uiAction: string,
  core: Workspace,
  options: { streamSamples: Set<number>; alive: () => boolean; onError: (message: string) => void },
) {
  requireVerification();
  const { streamSamples, alive, onError } = options;
  await Rxd.keepPreloadAwake(true);
  if (uiAction.startsWith('ui-theme')) enableThemeReporting();
  if (['ui-sample', 'ui-second', 'ui-stop-probe', 'ui-theme-sample'].includes(uiAction)) await core.model('test');
    if (uiAction.startsWith('ui-local-')) {
      await verifyLocalModel(core, uiAction);
    } else if (uiAction === 'ui-preferences' || uiAction === 'ui-preferences-reopen') {
      await verifyPreferences(core, uiAction === 'ui-preferences-reopen');
    } else if (uiAction === 'ui-theme-observe') {
      enableThemeReporting();
    } else if (uiAction === 'ui-theme-work') {
      await verifyAppearanceWork(core);
    } else if (uiAction === 'ui-sample' || uiAction === 'ui-second' || uiAction === 'ui-theme-sample') {
      await core.select(null);
      const source = uiAction === 'ui-second' ? 'export function nativeSecond(value) { return value * 2; }\n' : SAMPLE_SOURCE;
      const file = await Rxd.importSource(uiAction === 'ui-second' ? 'second.js' : uiAction === 'ui-theme-sample' ? `theme-${globalThis.crypto.randomUUID()}.js` : 'arxd-sample.js', source);
      await core.attach(file);
      await core.send(uiAction === 'ui-second' ? '分析第二个 JavaScript 文件。' : '分析 JavaScript 样本的结构。', file.id);
    } else if (uiAction === 'ui-context-capacity-layout') {
      await prepareCapacityUi(core);
    } else if (uiAction === 'ui-context-capacity-generation') {
      await prepareCapacityBusyUi(core);
    } else if (uiAction === 'ui-context-capacity-generation-release') {
      await releaseCapacityBusyUi(core);
    } else if (uiAction === 'ui-context-capacity-reduced-motion') {
      await core.motion('reduced');
    } else if (uiAction === 'ui-context-capacity-inspect') {
      await inspectCapacityUi(core, 'inspected');
    } else if (uiAction === 'ui-context-capacity-manual-hold' || uiAction === 'ui-context-capacity-manual-error' || uiAction === 'ui-context-capacity-manual-normal') {
      await prepareCapacityManualUi(core, uiAction.endsWith('hold') ? 'hold' : uiAction.endsWith('error') ? 'error' : 'normal');
    } else if (uiAction === 'ui-context-capacity-release') {
      await releaseCapacityUiSummary(core);
    } else if (uiAction === 'ui-context-capacity-cleanup') {
      await cleanupCapacityUi(core);
    } else if (uiAction === 'ui-context-capacity') {
      await verifyContextCapacity(core);
    } else if (uiAction === 'ui-context-capacity-reopen') {
      await reopenContextCapacity(core);
    } else if (uiAction === 'ui-files-probe') {
      await verifyFiles(core);
    } else if (uiAction === 'ui-shared-skills-pending') {
      await stagePendingSharedSkill(core);
      return;
    } else if (uiAction === 'ui-shared-skills-recover-pending') {
      await recoverPendingSharedSkill(core);
    } else if (uiAction === 'ui-shared-skills-stage-restart') {
      await stageSharedSkillsRestart(core);
      return;
    } else if (uiAction === 'ui-shared-skills-reopen') {
      await verifySharedSkillsReopen(core);
    } else if (uiAction === 'ui-shared-skills-probe') {
      await verifySharedSkills(core);
    } else if (uiAction === 'ui-deletion-probe') {
      await verifyDeletion(core);
    } else if (uiAction === 'ui-archive-probe') {
      await verifyArchive(core);
    } else if (uiAction === 'ui-skills-probe') {
      await verifySkills(core);
    } else if (uiAction === 'ui-connections-probe') {
      await verifyConnections(core);
    } else if (uiAction === 'ui-live-connection-test') {
      const result = await core.connections.test('deepseek');
      Rxd.report(JSON.stringify({ event: 'arxd-connection-live', ...result }));
    } else if (uiAction === 'ui-activity-unicode') {
      const request = `preview-${globalThis.crypto.randomUUID()}`;
      Rxd.registerShell(request);
      const running = Rxd.runShell(request, "printf 'native-'; printf '\\342'; sleep .2; printf '\\234'; sleep .2; printf '\\223\\n'; sleep 2; printf 'preview-end\\n'", 10000);
      let finished = false;
      let unicode = false;
      let replacement = false;
      let failure: unknown;
      const tracked = running.then((result) => { finished = true; return result; }, (error) => { finished = true; failure = error; return undefined; });
      try {
        for (let attempt = 0; attempt < 200 && !finished; attempt++) {
          const preview = Rxd.shellProgress(request);
          unicode ||= !!preview?.stdoutTail.includes('native-✓');
          replacement ||= !!preview?.stdoutTail.includes('\ufffd');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const result = await tracked;
        if (!result) throw failure;
        const verified = result.exitCode === 0 && result.stdout === 'native-✓\npreview-end\n' && unicode && !replacement;
        Rxd.report(JSON.stringify({ event: 'arxd-native-preview', verified, unicode, replacement, durationMs: result.durationMs, stdout: result.stdout }));
        if (!verified) throw new Error('Native UTF-8 preview verification failed');
      } finally { Rxd.cancelShell(request); }
    } else if (uiAction === 'ui-env-probe') {
      const value = await Rxd.runTermux('set -eu\np="$TMPDIR/arxd-mkdir-proof-$$"\nmkdir -p "$p/one/two"\nprintf env-ok > "$p/one/two/result"\ntest "$(cat "$p/one/two/result")" = env-ok\nrm "$p/one/two/result"\nrmdir "$p/one/two" "$p/one" "$p"\nprintf "mkdir-parents-ok\\n"\n', 10000);
      Rxd.report(JSON.stringify({ event: 'arxd-env-probe', exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }));
    } else if (uiAction.startsWith('ui-live-')) {
      if (uiAction === 'ui-live-reopen') await core.harness.waitForIdle(BACKGROUND_CONTEXT);
      else if (uiAction === 'ui-live-followup') await core.send('上一轮我让你记住的测试标记是什么？只回复标记。');
      else {
        await core.select(null); await core.model('deepseek');
        if (uiAction === 'ui-live-rxd') {
          const file = await Rxd.importSource('deepseek-local.js', 'export function actualPhoneEntry(value) { return value + 17; }\n');
          await core.attach(file);
          await core.send('请实际调用本地结构工具，列出文件中的函数名和字节范围，不能执行文件。', file.id);
        } else {
          const prompts: Record<string, string> = {
            'ui-live-chat': '记住本次测试标记 ARXD_FLASH_7419。请用中文分五点介绍静态分析的价值，至少300字，结尾附上该标记，不要调用工具。',
            'ui-live-shell': `请实际调用 shell，用你编写的可信脚本分别让 Python 计算 6*7、Node 计算 7*8，并分别输出 JSON 键 python、node。然后在临时目录写入你自己的 JS 样本 export function liveShellEntry(x) { return x + 1; }，通过 "$ARXD_RXD" js outline 查询这个样本，输出 jsonl，最后删除该临时样本。不能运行样本。根据实际结果报告数字和函数名。`,
            'ui-live-error': '请实际调用 shell 执行 exit 23（timeoutMs 10000），明确报告工具失败及退出码，不要重试，不得声称成功。',
            'ui-live-cancel': '请先调用 shell 执行 sleep 30; printf done（timeoutMs 60000），不要调用其他工具，也不要改写命令。',
            'ui-live-stream-crash': '不要调用任何工具，请用中文写一篇600字的静态分析教程，分六点讲解，最后输出 RECOVERED_FLASH。',
            'ui-live-stream-stop': '不要调用任何工具，请用中文写一篇至少3000字的静态分析教程，逐项详细解释。',
            'ui-live-activity': "请计算 2 的 10 次方，再实际调用一次 shell 执行 printf 'activity-first-✓\\n'; sleep 4; printf 'activity-last-✓\\n'，timeoutMs 为 10000。不调用其他工具，不安装软件，不创建文件。根据真实输出简短回答。",
          };
          const prompt = prompts[uiAction]; if (!prompt) throw new Error('Unknown live verification action');
          if (uiAction === 'ui-live-activity') await core.thinking('high');
          if (uiAction === 'ui-live-cancel' || uiAction === 'ui-live-stream-stop' || uiAction === 'ui-live-stream-crash' || uiAction === 'ui-live-activity') {
            void core.send(prompt).then(async (value) => { await reportUiStage('ui-live-finished', value); }).catch((failure) => { if (alive()) onError(String(failure)); });
            for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 50)); if ((await core.refresh()).busy) break; }
          } else await core.send(prompt);
        }
      }
      Rxd.report(JSON.stringify({ event: 'arxd-live-stream', stage: uiAction, samples: streamSamples.size }));
    } else if (uiAction === 'ui-stop-probe') {
      await core.select(null);
      void core.send('运行 Shell 停止验证').then(async (value) => { await reportUiStage('ui-task-finished', value); }).catch((failure) => { if (alive()) onError(String(failure)); });
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if ((await core.refresh()).busy) break;
      }
    } else if (uiAction === 'ui-spring') await core.palette('spring');
    else if (uiAction === 'ui-fire') await core.palette('fire');
    else if (uiAction === 'ui-new') await core.select(null);
    else await core.harness.waitForIdle(BACKGROUND_CONTEXT);
  await reportUiStage(uiAction, await core.refresh());
}

/** Stream-progress sampling the live verification reads from logcat. */
export function reportStreamSample(action: string | undefined, size: number, length: number) {
  Rxd.report(JSON.stringify({ event: 'arxd-live-stream', stage: action, samples: size, length }));
}

const activitySamples = new Set<string>();
/** Phase identities and timing only; never emit the model's thinking text. */
export function reportActivitySample(action: string | undefined, value: WorkspaceSnapshot) {
  if (action !== 'ui-live-activity') return;
  const turn = value.turns.at(-1);
  if (!turn) return;
  const preview = turn.activities.some((block) => block.kind === 'tool' && !!block.output);
  const key = `${turn.id}/${turn.phase}/${turn.status}/${preview}`;
  if (activitySamples.has(key)) return;
  activitySamples.add(key);
  Rxd.report(JSON.stringify({ event: 'arxd-activity', phase: turn.phase, status: turn.status, preview,
    thinkingBlocks: turn.activities.filter((block) => block.kind === 'thinking').length,
    runningTools: turn.activities.filter((block) => block.kind === 'tool' && block.state === 'running').length,
  }));
}
