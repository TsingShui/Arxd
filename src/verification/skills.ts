import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';

/** Own fixture bytes only. No model network request or imported script execution. */
export async function verifySkills(core: Workspace) {
  requireVerification();
  const directory = `arxd-skills-${globalThis.crypto.randomUUID()}`;
  const before = core.getSnapshot();
  const definition = '---\nname: phone-skill-probe\ndescription: Native skill verification fixture.\nlicense: MIT\n---\nRead references/guide.md before using scripts/probe.sh.\n';
  const reference = '✓中文'.repeat(200);
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  async function rejected(action: () => Promise<unknown>, label: string) {
    let failed = false; try { await action(); } catch { failed = true; }
    assert(failed, label);
  }
  await Rxd.createDirectory('workspace', directory);
  await Rxd.createDirectory('workspace', `${directory}/references`);
  await Rxd.createDirectory('workspace', `${directory}/scripts`);
  await Rxd.writeFile('workspace', `${directory}/SKILL.md`, definition, '');
  await Rxd.writeFile('workspace', `${directory}/references/guide.md`, reference, '');
  await Rxd.writeFile('workspace', `${directory}/references/binary.bin`, '\u0000binary', '');
  await Rxd.writeFile('workspace', `${directory}/scripts/probe.sh`, `printf ran > "$ARXD_WORKSPACE/${directory}/executed"\n`, '');
  let record;
  try {
    record = await core.skills.import('workspace', directory);
    assert(!record.enabled && record.status === 'active', 'Imported skill is disabled');
    const first = await Rxd.snapshotSkill(record.id, record.name, false);
    assert(first.files.length === 4 && first.files.some((file) => file.path === 'scripts/probe.sh'), 'Scripts and references are preserved');
    await Rxd.createDirectory('skills', `${first.workingPath}/empty-resource`);
    const withDirectory = await Rxd.snapshotSkill(record.id, record.name, false);
    assert(withDirectory.version !== first.version, 'Empty resource directories participate in version identity');
    const pinnedDirectory = await Rxd.runTermux(`test -d '${withDirectory.baseDirectory}/empty-resource'`, 10000);
    assert(pinnedDirectory.exitCode === 0, 'Pinned copy preserves empty directories');
    await Rxd.deleteFile('skills', `${first.workingPath}/empty-resource`);
    const file = first.files.find((item) => item.path === 'references/guide.md')!;
    let offset = 0, recovered = '';
    do {
      const page = await Rxd.readSkillResource(record.id, record.name, first.version, file.path, file.sha256, offset, 256);
      recovered += page.text; offset = page.nextOffset;
      if (page.complete) break;
    } while (offset < file.size);
    assert(recovered === reference, 'Native UTF-8 resource paging is byte exact');
    const binary = first.files.find((file) => file.path.endsWith('.bin'))!;
    assert((await Rxd.readSkillResource(record.id, record.name, first.version, binary.path, binary.sha256, 0, 256)).text === null, 'Binary resource returns metadata');
    await rejected(() => Rxd.readSkillResource(record!.id, record!.name, first.version, '../SKILL.md', first.definitionSha256, 0, 256), 'Resource traversal rejected');
    await core.skills.enabled(record.id, true);
    await core.select(null); await core.model('test'); await core.skills.choose(record.id, true);
    await rejected(() => Rxd.readFile('workspace', `${directory}/executed`), 'Import enable and selection do not execute scripts');
    await core.send('使用选中的技能；这是离线确定性验证。');
    const loaded = core.getSnapshot().turns.at(-1)?.tools.find((tool) => tool.name === 'skill_load');
    assert(!!loaded && !loaded.isError && loaded.text.includes('references/guide.md'), 'Real Android Pi harness loads selected skill on demand');
    const working = await core.skills.working(record.id);
    await core.skills.save(record.id, definition.replace('phone-skill-probe', 'phone-skill-renamed'), working.sha256);
    await rejected(() => core.skills.save(record!.id, definition, working.sha256), 'Stale skill edit rejected');
    assert((await core.skills.get(record.id))?.path.endsWith('/phone-skill-renamed'), 'Skill name edit renames the managed directory');
    const updated = await core.skills.working(record.id);
    const symlink = await Rxd.runTermux(`ln -s "$ARXD_WORKSPACE/${directory}/references/guide.md" "$ARXD_WORKSPACE/${updated.path}/linked"`, 10000);
    assert(symlink.exitCode === 0, 'Create isolated symlink fixture');
    await rejected(() => Rxd.snapshotSkill(record!.id, 'phone-skill-renamed', false), 'Linked skill resources rejected');
    await Rxd.deleteFile('workspace', `${updated.path}/linked`);
    for (const path of ['', 'skills', updated.path, '../outside']) await rejected(() => core.skills.import('workspace', path), 'Reject recursive or escaping import ' + JSON.stringify(path));
    await core.skills.choose(record.id, false); await core.skills.enabled(record.id, false);
    await core.skills.remove(record.id);
    assert(!((await core.skills.list()).some((item) => item.id === record!.id)), 'Deleted skill leaves the catalog');
    assert(core.getSnapshot().turns.at(-1)?.tools.some((tool) => tool.name === 'skill_load'), 'Delete preserves historical tool results');
    record = await core.skills.import('workspace', directory);
    Rxd.report(JSON.stringify({ event: 'arxd-skills', verified: true, checks, fixture: { id: record.id, name: record.name, directory }, mode: 'offline-deterministic/real-android-native-and-pi' }));
  } finally {
    if (record?.enabled) await core.skills.enabled(record.id, false);
    await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active);
  }
}
