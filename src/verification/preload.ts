import { requireVerification } from './access';
import Rxd, { type TermuxResult } from '../../modules/rxd';

import probes from '../../native/preload/probes.json';

const commands = probes as [string, string, number][];

export async function runPreloadChecks(progress: (stage: string) => void, bootstrapOnly = false) {
  requireVerification();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const report: { runId: string; identity?: Record<string, string | number | boolean>; stages: { stage: string; result: TermuxResult }[]; verified: boolean; error?: string } = { runId, stages: [], verified: false };
  let message = 0;
  async function publish(value: unknown) {
    const messageId = message++;
    const data = JSON.stringify(value);
    const parts = Math.ceil(data.length / 1500);
    for (let index = 0; index < parts; index++) {
      await Rxd.report(JSON.stringify({ event: 'arxd-verification-preload', runId, messageId, index, parts, data: data.slice(index * 1500, (index + 1) * 1500) }));
    }
  }
  try {
    await Rxd.keepPreloadAwake(true);
    progress('正在校验并初始化内置工具环境…');
    report.identity = await Rxd.prepareTermux();
    await publish({ kind: 'prepared', identity: report.identity });
    for (const [stage, script, timeout] of commands) {
      if (bootstrapOnly && stage !== 'bootstrap') break;
      progress(`正在验证 ${stage}…`);
      const result = await Rxd.runTermux(script, timeout);
      report.stages.push({ stage, result });
      await publish({ kind: 'stage', stage, result });
      if (result.exitCode !== 0) throw new Error(`${stage} exited ${result.exitCode}: ${result.stderr.slice(-2000)}`);
    }
    report.verified = !bootstrapOnly;
  } catch (error) { report.error = String(error); }
  await publish({ kind: 'complete', ...report });
  await Rxd.keepPreloadAwake(false);
  if (report.error) throw new Error(report.error);
  return report;
}
