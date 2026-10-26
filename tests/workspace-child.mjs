import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openWorkspace } from '../src/workspace/core.ts';
import { createHost, openDatabase } from './host-runtime.mjs';

const [stage, database, binary] = process.argv.slice(2);
const workspace = await openWorkspace(openDatabase(database), await createHost(binary));
try {
  await workspace.harness.waitForIdle(BACKGROUND_CONTEXT);
  let printed = false;
  if (stage === 'seed' || stage === 'second' || stage === 'invalid') {
    await workspace.select(null); await workspace.model('test');
    const name = stage === 'second' ? 'secondEntry' : 'firstEntry';
    const source = `export function ${name}(value) { return value + 2; }\n`;
    const path = join(dirname(database), `${stage}-${name}.js`); await writeFile(path, source);
    const file = { id: randomUUID(), name: `${name}.js`, source, size: Buffer.byteLength(source),
      sha256: stage === 'invalid' ? '0'.repeat(64) : createHash('sha256').update(source).digest('hex'),
      uri: pathToFileURL(path).href, format: 'JS' };
    await workspace.attach(file);
    await workspace.send(`Query ${name}`, file.id);
    if (stage === 'seed') await workspace.palette('spring');
  } else if (stage === 'instructions') {
    const before = await workspace.prompts.get();
    const cloud = await workspace.prompts.save({ name: 'Cloud prompt', text: 'Custom cloud instructions', scope: 'cloud', activate: true });
    const local = await workspace.prompts.save({ name: 'Local prompt', text: 'Custom local instructions', scope: 'local', activate: true });
    console.log(JSON.stringify({ before, cloud, local, after: await workspace.prompts.get() }));
    printed = true;
  } else if (stage === 'instructions-reopen') {
    console.log(JSON.stringify(await workspace.prompts.get()));
    printed = true;
  } else if (stage === 'branch') {
    await workspace.select(null); await workspace.model('test');
    const root = await workspace.send('Original question');
    const turnId = root.turns.at(-1).id;
    const edited = await workspace.editTurn(turnId, 'Edited question', '');
    const editedTurn = edited.turns.at(-1);
    const regenerated = await workspace.regenerate(editedTurn.id);
    const back = await workspace.select(root.active);
    console.log(JSON.stringify({
      root: { active: root.active, prompt: root.turns.at(-1).prompt },
      edited: { active: edited.active, prompts: edited.turns.map((turn) => turn.prompt), branch: edited.branch, conversations: edited.conversations.length },
      regenerated: { active: regenerated.active, prompts: regenerated.turns.map((turn) => turn.prompt), branch: regenerated.branch },
      back: { active: back.active, prompt: back.turns.at(-1).prompt, branch: back.branch, conversations: back.conversations.length },
    }));
    printed = true;
  } else if (stage === 'branch-reopen') {
    console.log(JSON.stringify(await workspace.refresh()));
    printed = true;
  } else if (stage === 'select-first') {
    const current = workspace.getSnapshot();
    const first = current.conversations.find((c) => c.title === 'Query firstEntry');
    assert.ok(first);
    await workspace.select(first.id);
  }
  if (!printed) {
    const snapshot = await workspace.refresh();
    const last = snapshot.turns.at(-1);
    console.log(JSON.stringify({ ...snapshot, report: last ? workspace.report(last.id)?.content ?? null : null }));
  }
} finally { await workspace.close(); }
