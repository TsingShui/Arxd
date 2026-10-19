import { openHostPoc } from './host-runtime.mjs';
import { waitForProcessKill } from '../src/verification/harness.ts';

const [stage, database, binary] = process.argv.slice(2);
const poc = await openHostPoc(database, binary, stage === 'checkpoint' ? async (context) => {
  console.log(JSON.stringify({ stage: 'checkpoint', pid: process.pid }));
  await waitForProcessKill(context);
} : undefined);
const snapshot = stage === 'recover' ? await poc.resume() : await poc.run(stage === 'seed' ? 'poc-seed-v1' : 'poc-recovery-v1');
console.log(JSON.stringify({ stage, snapshot }));
await poc.close();
