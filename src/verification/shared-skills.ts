import { requireVerification } from './access';
import { publishEvidence } from './evidence';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import { holdSkillRead } from './skill-provider';

/** Android acceptance: actual shell -> native filesystem/SQLite -> Pi skill_load. */
export async function verifySharedSkills(core: Workspace) {
  requireVerification();
  const name = `shared-probe-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const before = core.getSnapshot();
  const definition = `---\nname: ${name}\ndescription: Shared Android skill fixture.\n---\nRead references/guide.md.\n`;
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  const shell = async (script: string) => { const result = await Rxd.runTermux(script, 10000); assert(result.exitCode === 0, script.slice(0, 100)); return result.stdout; };
  async function waitFor(predicate: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 40; attempt++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
    throw new Error('Automatic shell skill reconciliation did not converge');
  }
  const rejected = async (action: () => Promise<unknown>, label: string) => { let failed = false; try { await action(); } catch { failed = true; } assert(failed, label); };
  let id: string | undefined;
  let release: (() => void) | undefined;
  try {
    await shell(`test -L "$HOME/skills" && test "$HOME/skills" -ef "$ARXD_SKILLS"`);
    await shell(`mkdir -p "$HOME/skills/.${name}/references"; printf %s '${definition}' > "$HOME/skills/.${name}/SKILL.md"; printf %s '原始✓resource' > "$HOME/skills/.${name}/references/guide.md"; printf %s 'touch "$HOME/skills/${name}/executed"' > "$HOME/skills/.${name}/probe.sh"; mv "$HOME/skills/.${name}" "$HOME/skills/${name}"`);
    await waitFor(async () => !!(await core.skills.list()).find((row) => row.name === name));
    const record = (await core.skills.list()).find((row) => row.name === name)!; id = record.id;
    assert(record.enabled && record.status === 'active', 'Shell-installed skill automatically discovered and enabled');
    assert(record.path === name, 'Installer-facing layout needs no internal UUID container');
    const unchanged = (await core.skills.refresh()).find((row) => row.id === id)!;
    assert(unchanged.id === id && unchanged.version === record.version && unchanged.updatedAt === record.updatedAt, 'Unchanged scans do not churn identity version or timestamps');
    await shell(`test ! -e "$HOME/skills/${name}/executed"`);
    await core.select(null); await core.model('test'); await core.skills.choose(id, true);
    await core.send('使用共享技能；离线确定性 Android 验证。');
    assert(core.getSnapshot().turns.at(-1)?.tools.some((tool) => tool.name === 'skill_load' && !tool.isError && tool.text.includes('references/guide.md')), 'Actual Android Pi task loads the published shared skill');
    await core.skills.enabled(id, false);
    const working = await core.skills.working(id);
    await core.skills.save(id, definition + 'APP_EDITED\n', working.sha256);
    assert((await shell(`cat "$HOME/skills/${name}/SKILL.md"`)).endsWith('APP_EDITED\n'), 'App edits are exact shell-visible bytes');
    await shell(`printf %s '更新✓resource' > "$HOME/skills/${name}/references/guide.md"`);
    await waitFor(async () => (await core.skills.get(id!))?.version !== record.version);
    assert(!(await core.skills.get(id))?.enabled, 'Shell update preserves disabled choice');
    // Real shell writes exercise the native bounded reader (including growth
    // beyond the old stat result), without a private parser/unit-test seam.
    await shell(`head -c 65537 /dev/zero > "$HOME/skills/${name}/SKILL.md"`);
    await waitFor(async () => !!(await core.skills.get(id!))?.error);
    const oversized = await Rxd.discoverSkills();
    assert(oversized.items.find((item) => item.id === id)?.definition === '', 'Oversized SKILL.md never returns a partial or unbounded definition');
    assert(!(await core.skills.get(id))?.enabled, 'Bounded definition rejection preserves disabled choice');
    const legacyBudget = globalThis.crypto.randomUUID();
    try {
      await shell(`mkdir -p "$ARXD_SKILLS/${legacyBudget}/first" "$ARXD_SKILLS/${legacyBudget}/second"; for i in $(seq 1 300); do touch "$ARXD_SKILLS/${legacyBudget}/$i"; done`);
      const legacy = await Rxd.discoverSkills();
      assert(legacy.scannedEntries <= 4096 && legacy.durationMs < 15000 && !!legacy.items.find((item) => item.folder === legacyBudget)?.error,
        'Legacy multi-child directory stays unmigrated and obeys the shared entry/time budget');
      await shell(`test -d "$ARXD_SKILLS/${legacyBudget}/first" && test -d "$ARXD_SKILLS/${legacyBudget}/second"`);
    } finally { await shell(`rm -rf "$ARXD_SKILLS/${legacyBudget}"`); }
    // Invalid writes and conflicts must not revive a disabled skill.
    await shell(`printf %s 'not frontmatter' > "$HOME/skills/${name}/SKILL.md"`);
    await waitFor(async () => (await core.skills.get(id!))?.status === 'invalid');
    assert(!(await core.skills.get(id))?.enabled, 'Invalid metadata retains desired disablement');
    await shell(`printf %s '${definition}' > "$HOME/skills/${name}/SKILL.md"`);
    await waitFor(async () => (await core.skills.get(id!))?.status === 'active');
    await shell(`mkdir "$HOME/skills/${name}-duplicate"; printf %s '${definition}' > "$HOME/skills/${name}-duplicate/SKILL.md"`);
    await waitFor(async () => (await core.skills.get(id!))?.status === 'invalid');
    assert(!(await core.skills.get(id))?.enabled, 'Duplicate names are explicit conflicts and preserve enablement');
    await rejected(() => core.skills.enabled(id!, true), 'Conflicting skill cannot be reenabled to bypass admission validation');
    await shell(`rm -rf "$HOME/skills/${name}-duplicate"; ln -s "$HOME" "$HOME/skills/${name}/linked"`);
    await waitFor(async () => !!(await core.skills.get(id!))?.error?.includes('symbolic'));
    await shell(`rm "$HOME/skills/${name}/linked"; head -c 2097153 /dev/zero > "$HOME/skills/${name}/oversize"`);
    await waitFor(async () => !!(await core.skills.get(id!))?.error?.includes('2 MiB'));
    await shell(`rm "$HOME/skills/${name}/oversize"; mkdir "$HOME/skills/${name}/too-many"; for i in $(seq 1 256); do touch "$HOME/skills/${name}/too-many/$i"; done`);
    await waitFor(async () => !!(await core.skills.get(id!))?.error?.includes('budget'));
    await shell(`rm -rf "$HOME/skills/${name}/too-many"`);
    await waitFor(async () => (await core.skills.get(id!))?.status === 'active');
    assert(!(await core.skills.get(id))?.enabled, 'Repairing invalid/oversize/link packages preserves prior disablement');
    await shell(`mv "$HOME/skills/${name}" "$HOME/skills/${name}-moved"`);
    await waitFor(async () => (await core.skills.get(id!))?.path === `${name}-moved`);
    assert((await core.skills.list()).filter((row) => row.id === id).length === 1, 'Completed directory move keeps one stable identity');
    await shell(`mv "$HOME/skills/${name}-moved" "$HOME/skills/${name}"`);
    await waitFor(async () => (await core.skills.get(id!))?.path === name);
    await rejected(() => Rxd.readFile('home', `skills/${name}/SKILL.md`), 'App file manager continues rejecting arbitrary link traversal');
    await shell(`mv "$HOME/skills" "$HOME/.${name}-alias"; mkdir "$HOME/skills"; printf preserved > "$HOME/skills/collision"`);
    const aliasConflict = await Rxd.discoverSkills();
    assert(!!aliasConflict.aliasError, 'Existing unrelated Home alias collision is reported');
    assert((await shell(`cat "$HOME/skills/collision"`)) === 'preserved', 'Alias collision preserves unrelated data');
    await shell(`rm "$HOME/skills/collision"; rmdir "$HOME/skills"; mv "$HOME/.${name}-alias" "$HOME/skills"`);
    assert(!(await Rxd.discoverSkills()).aliasError, 'Alias preparation is idempotent after collision resolution');
    // Hold the real Pi model boundary after skill_load, edit and delete via another actual shell.
    await core.skills.enabled(id, true);
    await core.skills.choose(id, false);
    let loaded!: () => void;
    const atCheckpoint = new Promise<void>((resolve) => { loaded = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    holdSkillRead(async () => { loaded(); await gate; });
    const running = core.send(`<arxd-shared-skills-probe name="${name}"/>`);
    await Promise.race([atCheckpoint, new Promise((_, reject) => setTimeout(() => reject(new Error('Pi did not load the shared skill')), 15000))]);
    await shell(`printf changed-after-admission > "$HOME/skills/${name}/references/guide.md"`);
    await core.skills.refresh();
    await shell(`rm -rf "$HOME/skills/${name}"`);
    await waitFor(async () => (await core.skills.get(id!))?.status !== 'active');
    await core.skills.refresh(); // Pending Pi work must prevent snapshot collection.
    release!(); await running; holdSkillRead();
    const pinned = core.getSnapshot().turns.at(-1)!;
    assert(pinned.tools.some((tool) => tool.name === 'skill_search' && !tool.isError), 'Pi discovers enabled metadata without explicit per-conversation selection');
    assert(pinned.tools.some((tool) => tool.name === 'skill_read' && !tool.isError && tool.text.includes('更新✓resource')), 'Admitted Pi task reads original pinned resource after live edit deletion and refresh');
    await core.send(`<arxd-shared-skills-probe name="${name}"/>`);
    assert(core.getSnapshot().turns.at(-1)?.answer.includes('OFFLINE_SHARED_SKILL_UNAVAILABLE'), 'Subsequent Pi input cannot discover a removed live skill');
    assert(!(await core.skills.list()).some((row) => row.id === id && row.status === 'active'), 'Shell deletion removes current availability');
    assert(core.getSnapshot().turns.some((turn) => turn.tools.some((tool) => tool.name === 'skill_load')), 'Shell deletion preserves historical tool results');
    const restartName = `${name}-restart`;
    await shell(`mkdir -p "$HOME/skills/${restartName}/references"; printf %s '${definition.replaceAll(name, restartName)}' > "$HOME/skills/${restartName}/SKILL.md"; printf before-restart > "$HOME/skills/${restartName}/references/guide.md"`);
    await waitFor(async () => !!(await core.skills.list()).find((row) => row.name === restartName && row.status === 'active'));
    const restart = (await core.skills.list()).find((row) => row.name === restartName)!;
    await core.skills.enabled(restart.id, false);
    const state = { name: restartName, id: restart.id, version: restart.version, probeName: name, probeId: id };
    const previous = await Rxd.readFile('workspace', '.shared-skills-verification.json').catch(() => undefined);
    await Rxd.writeFile('workspace', '.shared-skills-verification.json', JSON.stringify(state), previous?.sha256 ?? '');
    publishEvidence(JSON.stringify({ event: 'arxd-shared-skills', verified: true, checks, fixture: state, mode: 'offline-deterministic/real-android-shell-native-sqlite-pi' }));
  } finally {
    release?.(); holdSkillRead();
    await core.harness.waitForIdle(BACKGROUND_CONTEXT).catch(() => undefined);
    if (id) { await core.skills.choose(id, false).catch(() => undefined); await core.skills.remove(id).catch(() => undefined); }
    await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active);
  }
}

/** Called after a fresh process and an out-of-process Android shell update. */
export async function verifySharedSkillsReopen(core: Workspace) {
  requireVerification();
  const state = JSON.parse((await Rxd.readFile('workspace', '.shared-skills-verification.json')).text!);
  const record = await core.skills.get(state.id);
  if (!record || record.status !== 'active' || record.enabled || record.version === state.version || record.path !== state.name) throw new Error('Fresh-process shared skill reconciliation lost identity, disablement or content');
  const resources = (await Rxd.snapshotSkill(record.id, record.name, false)).files;
  const guide = resources.find((file) => file.path === 'references/guide.md')!;
  const snapshot = await Rxd.snapshotSkill(record.id, record.name, false);
  const read = await Rxd.readSkillResource(record.id, record.name, snapshot.version, guide.path, guide.sha256, 0, 256);
  if (read.text !== 'after-restart✓') throw new Error('Missed watcher event was not reconciled on fresh open');
  if (!core.getSnapshot().turns.some((turn) => turn.tools.some((tool) => tool.name === 'skill_load'))) {
    // Active conversation may differ; historical records are independently durable.
    const conversations = core.getSnapshot().conversations;
    let retained = false;
    for (const conversation of conversations) { await core.select(conversation.id); retained ||= core.getSnapshot().turns.some((turn) => turn.tools.some((tool) => tool.name === 'skill_load')); }
    if (!retained) throw new Error('Fresh process lost historical skill results');
  }
  publishEvidence(JSON.stringify({ event: 'arxd-shared-skills-reopen', verified: true, fixture: state, checks: ['Fresh process retains identity and desired disabled state', 'Inactive shell change and interrupted legacy layout reconcile without manual refresh', 'New version contains exact UTF-8 resource', 'Historical Pi tool results survive fresh process'] }));
}

/** Close the real storage owner/event consumer before an actual shell write, then restart. */
export async function stageSharedSkillsRestart(core: Workspace) {
  requireVerification();
  const state = JSON.parse((await Rxd.readFile('workspace', '.shared-skills-verification.json')).text!);
  const old = await core.skills.get(state.id);
  if (!old || old.enabled || old.version !== state.version) throw new Error('Restart fixture baseline changed');
  await core.close();
  const result = await Rxd.runTermux(`mkdir "$ARXD_SKILLS/${state.id}"; mv "$ARXD_SKILLS/${state.name}" "$ARXD_SKILLS/${state.id}/${state.name}"; printf %s 'after-restart✓' > "$ARXD_SKILLS/${state.id}/${state.name}/references/guide.md"`, 10000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Restart staging shell failed');
  publishEvidence(JSON.stringify({ event: 'arxd-shared-skills-stage-restart', verified: true, fixture: state, mode: 'real-android-shell/storage-owner-and-event-consumer-closed' }));
}

/** Persist a real admitted Pi task whose live skill is then removed; caller kills the App. */
export async function stagePendingSharedSkill(core: Workspace) {
  requireVerification();
  const name = `pending-skill-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const definition = `---\nname: ${name}\ndescription: Android recoverable pinned skill.\n---\nRead references/guide.md.\n`;
  const source = await Rxd.runTermux(`mkdir -p "$ARXD_SKILLS/${name}/references"; printf %s '${definition}' > "$ARXD_SKILLS/${name}/SKILL.md"; printf pending-original > "$ARXD_SKILLS/${name}/references/guide.md"`, 10000);
  if (source.exitCode !== 0) throw new Error(source.stderr);
  await core.skills.refresh();
  await core.select(null); await core.model('test');
  let loaded!: () => void;
  const checkpoint = new Promise<void>((resolve) => { loaded = resolve; });
  holdSkillRead(async () => { loaded(); await new Promise<void>(() => undefined); });
  void core.send(`<arxd-shared-skills-probe name="${name}"/>`).catch((failure) => { publishEvidence(JSON.stringify({ event: 'arxd-shared-skills-pending-error', error: String(failure) })); });
  await Promise.race([checkpoint, new Promise((_, reject) => setTimeout(() => reject(new Error('Pending skill checkpoint was not reached')), 15000))]);
  const record = (await core.skills.list()).find((row) => row.name === name)!;
  const state = { name, id: record.id, version: record.version, conversation: core.getSnapshot().active };
  const removed = await Rxd.runTermux(`rm -rf "$ARXD_SKILLS/${name}"`, 10000);
  if (removed.exitCode !== 0) throw new Error(removed.stderr);
  await core.skills.refresh();
  const previous = await Rxd.readFile('workspace', '.shared-skills-pending-verification.json').catch(() => undefined);
  await Rxd.writeFile('workspace', '.shared-skills-pending-verification.json', JSON.stringify(state), previous?.sha256 ?? '');
  publishEvidence(JSON.stringify({ event: 'arxd-shared-skills-pending', verified: true, fixture: state, mode: 'offline-deterministic/real-pi-task-pending-after-live-removal' }));
}

export async function recoverPendingSharedSkill(core: Workspace) {
  requireVerification();
  const state = JSON.parse((await Rxd.readFile('workspace', '.shared-skills-pending-verification.json')).text!);
  await core.harness.waitForIdle(BACKGROUND_CONTEXT);
  await core.select(state.conversation);
  const turn = core.getSnapshot().turns.at(-1)!;
  if (!turn.tools.some((tool) => tool.name === 'skill_read' && !tool.isError && tool.text.includes('pending-original'))) throw new Error('Fresh process pruned or failed to recover the admitted version: ' + turn.answer);
  if ((await core.skills.get(state.id))?.status === 'active') throw new Error('Removed pending skill was wrongly readmitted');
  publishEvidence(JSON.stringify({ event: 'arxd-shared-skills-recovered', verified: true, checks: ['Real Pi task remains durable after live skill deletion', 'Fresh process resumes resource read from original admitted version', 'Live removal stays unavailable for future tasks'] }));
}
