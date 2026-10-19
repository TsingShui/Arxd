import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';
import { createSkillHost } from './skill-host.mjs';
const [database, binary] = process.argv.slice(2);
const root = dirname(database); await mkdir(join(root, 'workspace'), { recursive: true });
const host = await createHost(binary); host.skills = createSkillHost(root);
host.credentials = { get: async () => ({ apiKey: 'small-skill-fixture-key' }), put: async () => {}, remove: async () => {} };
let long, short, nextOffset = 0, recovered = '', calls = 0;
const guide = '中文✓'.repeat(200);
host.live = { fetch: async (_url, options) => {
  const request = JSON.parse(options.body); const serialized = JSON.stringify(request.messages);
  assert.ok(!serialized.includes('LONG_INSTRUCTION_CONTENT'));
  assert.ok(request.messages.some((message) => typeof message.content === 'string' && message.content.includes('"metadataComplete":false')));
  const results = request.messages.filter((message) => message.role === 'tool');
  let delta;
  const tool = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!results.length) delta = tool('long', 'skill_load', { id: long.id, version: long.version });
  else if (results.at(-1).tool_call_id === 'long') { assert.ok(results.at(-1).content.includes('context budget')); delta = tool('short', 'skill_load', { id: short.id, version: short.version }); }
  else if (results.at(-1).tool_call_id === 'short') delta = tool('read-first', 'skill_read', { id: short.id, version: short.version, path: 'references/guide.md', maxBytes: 65536 });
  else {
    const page = JSON.parse(results.at(-1).content);
    assert.ok(page.nextOffset - page.offset <= 1024); recovered += page.text; nextOffset = page.nextOffset;
    delta = page.complete ? { content: 'SMALL_SKILL_OK' } : tool('read-next', 'skill_read', { id: short.id, version: short.version, path: 'references/guide.md', offset: nextOffset, maxBytes: 65536 });
  }
  calls++;
  return new Response(`data: ${JSON.stringify({ id: 'small-skill-' + calls, object: 'chat.completion.chunk', model: 'small-probe', choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} };
const core = await openWorkspace(openDatabase(database), host);
try {
  const connection = await core.connections.save({ name: 'Small skill fixture', preset: 'custom', protocol: 'openai-completions', endpoint: 'https://fixture.invalid/v1', auth: 'key' });
  const model = await core.connections.manual(connection.id, { id: 'small-probe', name: 'Small probe', contextWindow: 8192, maxTokens: 1024, thinking: ['off'] }, { maxTokens: 64 }, true);
  await core.model(model.id);
  async function skill(name, description, body) {
    const path = join(root, 'workspace', name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
    if (name === 'short-instructions') { await mkdir(join(path, 'references')); await writeFile(join(path, 'references/guide.md'), guide); }
    const record = await core.skills.import('workspace', name); await core.skills.enabled(record.id, true); return record;
  }
  short = await skill('short-instructions', 'Read the compact guide.', 'Read references/guide.md in pages.');
  long = await skill('long-instructions', 'Large instruction boundary fixture.', 'LONG_INSTRUCTION_CONTENT'.repeat(700));
  for (let index = 0; index < 2; index++) await skill(`metadata-${index}`, '元数据'.repeat(341), 'Metadata-only fixture.');
  await core.skills.choose(long.id, true); await core.skills.choose(short.id, true);
  await core.send('Try the selected long definition, then the short guide if it exceeds the budget.');
  assert.equal(core.getSnapshot().turns.at(-1).answer, 'SMALL_SKILL_OK');
  assert.equal(recovered, guide);
  const tools = core.getSnapshot().turns.at(-1).tools;
  assert.equal(tools.length, 4); assert.equal(tools[0].isError, true); assert.equal(tools[1].isError, false);
  assert.equal(tools[0].details.skillName, 'long-instructions');
  console.log(JSON.stringify({ verified: true, calls, resourceBytes: Buffer.byteLength(recovered) }));
} finally { await core.close(); }
