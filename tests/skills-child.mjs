import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
import { createSkillHost } from './skill-host.mjs';

const [stage, database, binary] = process.argv.slice(2);
const root = dirname(database), statePath = join(root, 'skills-state.json');
await mkdir(join(root, 'home'), { recursive: true });
await mkdir(join(root, 'workspace'), { recursive: true });
const host = await createHost(binary, undefined, { root, jobs: new Map() });
host.skills = createSkillHost(root);
let workspace, activeSkill;
let mode = stage === 'replay-disabled' ? 'disabled' : 'workflow';
let changed = false;
let calls = 0;
const definition = '---\nname: probe-workflow\ndescription: >-\n  Use for the isolated skill workflow probe.\nlicense: MIT\nmetadata:\n  author: fixture\n---\nBODY_OLD_ONLY_AFTER_LOAD\nRead references/guide.md, then run scripts/probe.sh with Bash.\n';
host.live = {
  getKey: async () => 'sk-offline-skills-fixture-12345678',
  fetch: async (_url, options) => {
    const request = JSON.parse(options.body); calls++;
    const results = request.messages.filter((message) => message.role === 'tool');
    const user = request.messages.filter((message) => message.role === 'user').at(-1).content;
    const thisResults = mode === 'disabled' ? results.slice(-1) : results;
    let message;
    if (mode === 'disabled') {
      message = user.includes('TRY_DISABLED') && thisResults.at(-1)?.tool_call_id !== 'disabled-call'
        ? { tool_calls: [{ id: 'disabled-call', type: 'function', function: { name: 'skill_load', arguments: JSON.stringify({ id: activeSkill.id, version: activeSkill.version }) } }] }
        : { content: 'Disabled skill rejected.' };
    } else if (!results.length) {
      const system = JSON.stringify(request.messages.filter((item) => item.role === 'system' || item.role === 'developer'));
      assert.ok(system.includes('probe-workflow') && !system.includes('BODY_OLD_ONLY_AFTER_LOAD'));
      const native = await host.skills.working(activeSkill.id);
      await assert.rejects(workspace.skills.save(activeSkill.id, definition, native.sha256), /停止/);
      await writeFile(join(root, 'workspace', native.path, 'SKILL.md'), definition.replace('BODY_OLD_ONLY_AFTER_LOAD', 'BODY_NEW_FOR_NEXT_INPUT'));
      await writeFile(join(root, 'workspace', native.path, 'references/guide.md'), 'NEW_REFERENCE');
      await workspace.skills.refresh();
      changed = true;
      message = { tool_calls: [{ id: 'search-call', type: 'function', function: { name: 'skill_search', arguments: JSON.stringify({ query: 'probe' }) } }] };
    } else if (results.at(-1).tool_call_id === 'search-call') {
      const found = JSON.parse(results.at(-1).content).skills;
      assert.equal(found[0].version, activeSkill.version);
      message = { tool_calls: [{ id: 'load-call', type: 'function', function: { name: 'skill_load', arguments: JSON.stringify({ id: activeSkill.id, version: activeSkill.version }) } }] };
    } else if (results.at(-1).tool_call_id === 'load-call') {
      const loaded = JSON.parse(results.at(-1).content);
      assert.ok(loaded.definition.includes('BODY_OLD_ONLY_AFTER_LOAD'));
      assert.ok(!loaded.definition.includes('BODY_NEW_FOR_NEXT_INPUT'));
      message = { tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'skill_read', arguments: JSON.stringify({ id: activeSkill.id, version: activeSkill.version, path: 'references/guide.md', offset: 0, maxBytes: 1024 }) } }] };
    } else if (results.at(-1).tool_call_id === 'read-call') {
      assert.equal(JSON.parse(results.at(-1).content).text, 'OLD_REFERENCE');
      const loaded = JSON.parse(results.find((item) => item.tool_call_id === 'load-call').content);
      message = { tool_calls: [{ id: 'shell-call', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ script: `bash '${loaded.baseDirectory}/scripts/probe.sh'`, timeoutMs: 10000 }) } }] };
    } else { assert.ok(results.at(-1).content.includes('SKILL_SCRIPT_OK')); message = { content: 'Offline fixture completed the pinned skill workflow.' }; }
    const tool = !!message.tool_calls;
    const payload = { id: `skill-${calls}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: message, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    if (tool) payload.choices[0].delta.tool_calls = message.tool_calls.map((item, index) => ({ index, ...item }));
    return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  },
};
workspace = await openWorkspace(openDatabase(database), host);
try {
  await workspace.harness.waitForIdle(BACKGROUND_CONTEXT);
  if (stage === 'seed') {
    const input = join(root, 'workspace/input-skill');
    await mkdir(join(input, 'scripts'), { recursive: true }); await mkdir(join(input, 'references'));
    await writeFile(join(input, 'SKILL.md'), definition);
    await writeFile(join(input, 'references/guide.md'), 'OLD_REFERENCE');
    await writeFile(join(input, 'scripts/probe.sh'), `printf 'SKILL_SCRIPT_OK\\n'\nprintf ran > '${join(root, 'executed')}'\n`);
    activeSkill = await workspace.skills.import('workspace', 'input-skill');
    assert.equal(activeSkill.enabled, false); await assert.rejects(readFile(join(root, 'executed')));
    await workspace.skills.enabled(activeSkill.id, true); await workspace.skills.choose(activeSkill.id, true);
    await assert.rejects(readFile(join(root, 'executed')));
    await workspace.model('deepseek'); await workspace.send('Use the selected skill for the isolated probe.');
    assert.ok(changed); assert.equal(workspace.getSnapshot().turns.at(-1).tools.length, 4);
    assert.equal((await readFile(join(root, 'executed'), 'utf8')), 'ran');
    assert.ok(workspace.getSnapshot().turns.at(-1).tools.every((tool) => !tool.isError));
    assert.notEqual((await workspace.skills.get(activeSkill.id)).version, activeSkill.version);
    await writeFile(statePath, JSON.stringify({ id: activeSkill.id, version: activeSkill.version, snapshot: workspace.getSnapshot() }));
  } else if (stage === 'reopen') {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(workspace.getSnapshot().turns, saved.snapshot.turns);
    const working = await workspace.skills.working(saved.id);
    const updated = await workspace.skills.save(saved.id, working.definition.replace('probe-workflow', 'renamed-workflow'), working.sha256);
    assert.equal(updated.name, 'renamed-workflow'); assert.ok(updated.path.endsWith('/renamed-workflow'));
    await assert.rejects(workspace.skills.save(saved.id, definition, working.sha256), /changed/);
    await workspace.skills.enabled(saved.id, false);
    await assert.rejects(workspace.send('Selected but disabled'), /已选技能/);
    await workspace.skills.choose(saved.id, false);
    activeSkill = saved; mode = 'disabled';
    await workspace.send('TRY_DISABLED');
    assert.ok(workspace.getSnapshot().turns.at(-1).tools[0].isError);
    await workspace.skills.remove(saved.id);
    assert.equal((await workspace.skills.list()).length, 0);
    assert.ok(workspace.getSnapshot().turns[0].tools[1].text.includes('BODY_OLD_ONLY_AFTER_LOAD'));
    const bad = join(root, 'bad.md'); await writeFile(bad, '---\nname: BAD\ndescription: wrong\n---\n');
    await assert.rejects(workspace.skills.import('file', pathToFileURL(bad).href), /名称/);
    assert.equal((await workspace.skills.list()).length, 0);
  }
  console.log(JSON.stringify({ verified: true, calls, snapshot: workspace.getSnapshot() }));
} finally { await workspace.close(); }
