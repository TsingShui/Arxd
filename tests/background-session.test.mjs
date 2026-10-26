import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRunner } from '../src/background/session.ts';

test('background ownership covers the entire operation, including time without child processes', async () => {
  const events = []; let finish;
  const runner = sessionRunner({ enabled: () => true, acquire: async id => events.push('acquire:'+id), release: id => events.push('release:'+id) }, () => 'one');
  const pending = runner.run(() => new Promise(resolve => { finish = resolve; events.push('execute'); }), () => { events.push('stop'); finish('done'); });
  await Promise.resolve();
  assert.deepEqual(events, ['acquire:one', 'execute']);
  await runner.stop(); assert.ok(events.includes('stop'));
  assert.equal(await pending, 'done'); assert.equal(events.at(-1), 'release:one');
});
test('Stop retains the headless lease until the cancelled operation actually settles', async () => {
  let finish, posted = false, stopped = false;
  const runner = sessionRunner({ enabled: () => true, acquire: async () => {}, release: () => {} }, () => 'one');
  const pending = runner.run(() => new Promise(resolve => finish = resolve), () => { posted = true; });
  await Promise.resolve();
  const stopping = runner.stop().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(posted, true); assert.equal(stopped, false);
  finish(); await pending; await stopping; assert.equal(stopped, true);
});
test('failed admission never starts a shell and always releases its own lease', async () => {
  let ran = false, released = 0;
  const runner = sessionRunner({ enabled: () => true, acquire: async () => { throw Error('denied'); }, release: () => released++ }, () => 'one');
  await assert.rejects(runner.run(async () => { ran = true; }, () => {}), /denied/);
  assert.equal(ran, false); assert.equal(released, 1);
});
test('disabled background mode preserves foreground operation and concurrent stops reach all owners', async () => {
  let enabled = false, acquired = 0, stopped = 0, n = 0;
  const runner = sessionRunner({ enabled: () => enabled, acquire: async () => { acquired++; }, release: () => {} }, () => String(n++));
  assert.equal(await runner.run(async () => 42, () => { throw Error('must not stop finished foreground work'); }), 42);
  assert.equal(acquired, 0); enabled = true;
  const finishes = [];
  const tasks = [0,1].map((i) => runner.run(() => new Promise(resolve => finishes[i] = resolve), () => { stopped++; finishes[i](); }));
  await Promise.resolve(); await runner.stop(); assert.equal(stopped, 2);
  await Promise.all(tasks);
  await runner.stop(); assert.equal(stopped, 2);
});
