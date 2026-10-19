import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import { enableThemeReporting, themeSnapshot } from '../ui/appearance';

export async function verifyAppearanceWork(core: Workspace) {
  requireVerification();
  enableThemeReporting();
  const before = core.getSnapshot(); const checks: string[] = [];
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  await core.select(null); await core.model('test');
  const running = core.send('运行 Shell 停止验证');
  try {
    let preview = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await core.refresh();
      preview = value.turns.at(-1)?.activities.some((block) => block.kind === 'tool' && block.state === 'running' && block.output?.includes('cancellation probe started')) ?? false;
      if (preview) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(preview, 'A real managed shell is running before appearance changes');
    const id = core.getSnapshot().active;
    await core.theme('spring'); await core.appearance('dark'); await core.motion('reduced');
    for (let attempt = 0; attempt < 40; attempt++) { if (themeSnapshot().palette === 'spring' && themeSnapshot().scheme === 'dark' && themeSnapshot().reducedMotion) break; await new Promise((resolve) => setTimeout(resolve, 25)); }
    assert(core.getSnapshot().active === id && core.getSnapshot().busy, 'Theme updates retain the active task and conversation');
    assert(themeSnapshot().scheme === 'dark' && themeSnapshot().palette === 'spring' && themeSnapshot().reducedMotion, 'The shared UI theme updates during the real tool call');
    await core.stop(); await running;
    assert(core.getSnapshot().turns.at(-1)?.status === 'stopped', 'The themed UI still cancels its native shell task');
    Rxd.report(JSON.stringify({ event: 'arxd-appearance-work', verified: true, checks }));
  } finally {
    await core.stop(); await running.catch(() => undefined);
    await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active);
    await core.theme(before.palette); await core.appearance(before.appearance); await core.motion(before.motion);
  }
}
