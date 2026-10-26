import test from 'node:test';
import assert from 'node:assert/strict';
import { TermuxAdb, ADB_SERVER, connectionScript, pairingScript } from '../src/adb/termux.ts';

test('ADB is the original unrestricted Termux CLI, with separate ordinary and shell identities', () => {
  assert.match(ADB_SERVER.script, /exec adb .*nodaemon server/);
  assert.match(connectionScript(37123), /adb -s 127.0.0.1:37123 shell id -u/);
  assert.match(connectionScript(37123), /2000/);
  assert.match(connectionScript(37123), /ANDROID|arxd-adb-target/);
  for (const port of [0, -1, 65536, NaN, 3.5, '5555;reboot']) assert.throws(() => connectionScript(port));
  assert.equal(pairingScript(37123), 'exec timeout -k 2 30 adb pair 127.0.0.1:37123');
});
test('pairing code goes only to stdin, never retained process definitions or command arguments', async () => {
  const saved = []; let input; let state = 'queued';
  const services = { start: async (_, def) => { saved.push(def); return { id:'pair', state }; },
    inspect: async () => ({ state: state = 'running' }), write: async (...args) => { input = args; }, stop: async () => {} };
  const adb = new TermuxAdb(services, () => 'admission', async () => {});
  await adb.pair(37123, '123456');
  assert.equal(JSON.stringify(saved).includes('123456'), false);
  assert.deepEqual(input, ['pair', '123456\n', true]);
  await assert.rejects(adb.pair(37123, 'not-a-code'), /invalid_code/);
});
test('Stop only addresses the CLI-owned server and failed pairing input is cleaned up', async () => {
  const stopped = [];
  const services = { list: async () => ({ items:[{ id:'ours', origin:'arxd-adb-cli', state:'running' },{ id:'unrelated', origin:'user', state:'running' }], nextOffset:null }),
    stop: async id => stopped.push(id), start: async () => ({ id:'pair' }), inspect: async () => ({ state:'running' }), write: async () => { throw Error('closed'); } };
  const adb = new TermuxAdb(services, () => 'admission', async () => {});
  assert.equal((await adb.start()).id, 'ours');
  await adb.stop(); assert.deepEqual(stopped, ['ours']);
  await assert.rejects(adb.pair(37123, '123456'), /closed/); assert.equal(stopped.at(-1), 'pair');
});
