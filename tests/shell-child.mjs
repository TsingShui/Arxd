import { openHostPoc } from './host-runtime.mjs';
import { waitForProcessKill } from '../src/verification/harness.ts';

const [stage, database, binary, root] = process.argv.slice(2);
const poc = await openHostPoc(database, binary, undefined, stage === 'rxd-seed' ? false : {
  root, jobs: new Map(),
  afterRun: stage === 'checkpoint' ? async (_result, context) => {
    console.log(JSON.stringify({ stage: 'checkpoint', pid: process.pid }));
    await waitForProcessKill(context);
  } : undefined,
});
const snapshot = stage === 'recover' ? await poc.resume() : await poc.run(`shell-${stage}`, stage === 'rxd-seed' ? 'rxd' : 'shell');
console.log(JSON.stringify({ stage, snapshot }));
await poc.close();
