import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import Rxd from '../../modules/rxd';
import { SAFETY_INSTRUCTIONS } from '../agent/instructions';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import { PreferencesDoc } from '../workspace/preferences';
import { requireVerification } from './access';
import { publishEvidence } from './evidence';

const ProbeDoc = defineDoc<{ snapshot: string; prompts: string; instructions: string }>({
  kind: 'arxd.verification.preferences', version: 1, scope: 'session',
  initial: () => ({ snapshot: '', prompts: '', instructions: '' }),
});

function durableState(value: WorkspaceSnapshot): string {
  // Capacity is a live projection, not persisted preferences. Timings and real
  // tool results remain in the comparison to detect transcript regressions too.
  const { active, model, thinking, palette, appearance, motion, importLimit, files, turns } = value;
  return JSON.stringify({ active, model, thinking, palette, appearance, motion, importLimit, files, turns });
}

/** Offline preference checks through the actual Android workspace, Pi and SQLite.
 * The manual connection only exercises configuration; it never sends a request. */
export async function verifyPreferences(core: Workspace, reopen: boolean) {
  requireVerification();
  const checks: string[] = [];
  const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };
  const instructions = async () => {
    const id = core.getSnapshot().active;
    const conversation = id === null ? undefined : await core.harness.conversation(id, BACKGROUND_CONTEXT);
    return (await conversation?.agent(BACKGROUND_CONTEXT))?.instructions ?? '';
  };
  if (reopen) {
    const expected = await core.harness.snapshot(ProbeDoc, BACKGROUND_CONTEXT);
    assert(!!expected?.snapshot, 'A prior process committed preference evidence');
    assert(durableState(await core.refresh()) === expected?.snapshot, 'Preferences, real tool results and timings survive a fresh process');
    assert(JSON.stringify(await core.prompts.get()) === expected?.prompts, 'Prompt profiles and independent selections survive a fresh process');
    assert(await instructions() === expected?.instructions, 'Configured conversation instructions survive a fresh process');
  } else {
    await core.select(null);
    await core.model('test');
    const file = await Rxd.importSource('preferences-probe.js', 'export function preferenceDeviceProbe(value) { return value + 23; }\n');
    await core.attach(file);
    await core.send('Analyze this preference verification fixture.', file.id);
    const completed = core.getSnapshot();
    const turn = completed.turns.at(-1);
    assert(turn?.status === 'done' && turn.provider === 'faux', 'Deterministic faux provider is explicitly identified');
    assert(turn?.tools.some((tool) => !tool.isError && tool.text.includes('preferenceDeviceProbe')), 'Real Android rxd analyzes captured bytes');
    const transcript = JSON.stringify(completed.turns);

    const connection = await core.connections.save({ name: 'Preference fixture (no requests)', preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:9/unused', auth: 'none' });
    const model = await core.connections.manual(connection.id, { id: 'preferences-probe', name: 'Preference fixture (configuration only)', contextWindow: 128000, maxTokens: 1024, thinking: ['off', 'high'] }, {}, true);
    await core.model(model.id);
    await core.thinking('high');
    await core.model('test');
    assert(core.getSnapshot().thinking === 'off', 'Test model does not inherit another model thinking level');
    await core.model(model.id);
    assert(core.getSnapshot().thinking === 'high', 'Returning to a model restores its explicit thinking level');
    await core.harness.commit(async (tx) => {
      const prefs = await tx.doc(PreferencesDoc);
      delete prefs.thinkingByModel;
      prefs.thinking = 'high';
    }, BACKGROUND_CONTEXT);
    await core.model('test');
    await core.model(model.id);
    assert(core.getSnapshot().thinking === 'high', 'Legacy single thinking preference is materialized before switching models');

    const cloud = await core.prompts.save({ name: 'Cloud verification', text: 'CLOUD_PREFERENCE_FIXTURE', scope: 'cloud', activate: true });
    const local = await core.prompts.save({ name: 'Local verification', text: 'LOCAL_PREFERENCE_FIXTURE', scope: 'local', activate: true });
    const configured = await instructions();
    assert(configured === `${SAFETY_INSTRUCTIONS}\n\nCLOUD_PREFERENCE_FIXTURE`, 'Cloud selection configures the open conversation and retains the safety preamble');
    let prompts = await core.prompts.get();
    assert(prompts.active.cloud === cloud.id && prompts.active.local === local.id, 'Cloud and local prompt selections remain independent');
    const temporary = await core.prompts.save({ name: 'Temporary verification', text: 'TEMPORARY_FIXTURE', scope: 'cloud', activate: true });
    await core.prompts.select('local', temporary.id);
    await core.prompts.remove(temporary.id);
    prompts = await core.prompts.get();
    assert(prompts.active.cloud === null && prompts.active.local === null, 'Deleting a selected profile resets both referring scopes');
    await core.prompts.select('cloud', cloud.id);
    await core.prompts.select('local', local.id);

    await core.harness.commit(async (tx) => {
      const prefs = await tx.doc(PreferencesDoc);
      prefs.palette = 'fire';
      delete prefs.appearance;
    }, BACKGROUND_CONTEXT);
    assert((await core.refresh()).appearance === 'dark', 'Legacy Fire palette resolves to dark appearance');
    await core.theme('spring');
    assert(core.getSnapshot().appearance === 'light', 'Legacy Spring palette resolves to light appearance');
    await core.appearance('dark');
    await core.motion('reduced');
    await core.importLimit(2 * 1024 * 1024);
    assert(core.getSnapshot().active === completed.active && JSON.stringify(core.getSnapshot().turns) === transcript, 'Preference changes preserve the conversation and real analysis transcript');
    const snapshot = durableState(await core.refresh());
    const savedPrompts = JSON.stringify(await core.prompts.get());
    const savedInstructions = await instructions();
    await core.harness.commit(async (tx) => {
      const probe = await tx.doc(ProbeDoc);
      probe.snapshot = snapshot;
      probe.prompts = savedPrompts;
      probe.instructions = savedInstructions;
    }, BACKGROUND_CONTEXT);
  }
  const value = await core.refresh();
  const engine = await Rxd.getInfo();
  publishEvidence(JSON.stringify({ event: 'arxd-preferences', stage: reopen ? 'reopen' : 'seed', verified: true,
    mode: 'offline-deterministic/real-android-pi-sqlite-rxd', checks, engine,
    active: value.active, thinking: value.thinking, appearance: value.appearance, motion: value.motion, importLimit: value.importLimit,
    toolCount: value.turns.flatMap((turn) => turn.tools).length,
  }));
}
