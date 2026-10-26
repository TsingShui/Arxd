// Explicit opt-in network check. Never run from the ordinary offline test suite.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from '../tests/host-runtime.mjs';

const keyFile = process.argv[2];
if (!keyFile) throw new Error('Pass a private API-key file path');
const secret = (await readFile(keyFile, 'utf8')).trim();
const root = resolve(import.meta.dirname, '../../..');
const directory = resolve(root, 'target/arxd/live-host', randomUUID());
await mkdir(directory, { recursive: true });
const path = resolve(directory, 'workspace.sqlite');
const host = await createHost(resolve(root, 'target/release/rxd'));
host.live = { getKey: async () => secret };
let workspace = await openWorkspace(openDatabase(path), host);
try {
  await workspace.model('deepseek');
  const source = 'export function sdkProbe(value) { return value + 13; }\n';
  const file = { id: randomUUID(), name: 'sdk-probe.js', source, uri: 'file:///trusted-test-capture.js',
    size: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), format: 'JS' };
  await workspace.attach(file);
  const lengths = new Set();
  const unsubscribe = workspace.subscribe((s) => { if (s.busy && s.turns.at(-1)?.answer) lengths.add(s.turns.at(-1).answer.length); });
  const first = await workspace.send('实际调用结构查询工具，列出函数名和字节范围，不要执行样本。', file.id);
  unsubscribe();
  assert.equal(first.model, 'deepseek');
  assert.equal(first.turns[0].status, 'done', first.turns[0].answer);
  assert.ok(first.turns[0].tools.some((t) => ['shell', 'codemode'].includes(t.name) && !t.isError && t.text.includes('sdkProbe')));
  assert.match(first.turns[0].answer, /sdkProbe/);
  await workspace.close();
  workspace = await openWorkspace(openDatabase(path), host);
  assert.deepEqual(workspace.getSnapshot().turns, first.turns);
  const follow = await workspace.send('上一轮分析的函数叫什么？只回答函数名，不调用工具。');
  assert.match(follow.turns.at(-1).answer, /sdkProbe/);
  assert.equal(follow.turns.at(-1).tools.length, 0);
  await writeFile(resolve(directory, 'proof.json'), JSON.stringify({ verified: true, provider: 'deepseek', model: 'deepseek-flash',
    conversationId: first.active, tools: first.turns[0].tools.map((t) => t.name), answer: first.turns[0].answer,
    followup: follow.turns.at(-1).answer, partialLengths: [...lengths] }, null, 2));
  console.log(JSON.stringify({ verified: true, evidence: directory, tools: first.turns[0].tools.map((t) => t.name) }));
} catch (error) {
  // Provider diagnostics must never print the supplied credential.
  console.error(String(error).replaceAll(secret, '[REDACTED]'));
  process.exitCode = 1;
} finally { await workspace.close(); }
