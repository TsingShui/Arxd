import assert from 'node:assert/strict';
import test from 'node:test';
import { adbBusy, adbError, adbErrors, adbLabel, adbPort, adbReady } from '../src/adb/state.ts';
import { en } from '../src/i18n/en.ts';
import { zh } from '../src/i18n/zh.ts';

const paired = { supported: true, phase: 'disconnected', paired: true, port: 32000, uid: null, checkedAt: null, error: null };
test('ADB authorization never confuses pairing history, a root UID or saved state with a verified shell channel', () => {
  assert.equal(adbReady(paired), false);
  assert.equal(adbLabel(paired), 'Paired, not connected');
  const verified = { ...paired, phase: 'connected', uid: 2000, checkedAt: 123 };
  assert.equal(adbReady(verified), true);
  for (const state of [undefined, { ...verified, phase: 'connecting' }, { ...verified, uid: 0 }, { ...verified, checkedAt: null }, { ...verified, checkedAt: NaN }, { ...verified, supported: false }]) assert.equal(adbReady(state), false);
  for (const phase of ['pairing', 'connecting', 'checking']) assert.equal(adbBusy({ ...paired, phase }), true);
  assert.equal(adbBusy(paired), false);
  for (const state of [undefined, { ...paired, supported: false }, verified, paired, { ...paired, paired: false }, ...['pairing', 'connecting', 'checking'].map(phase => ({ ...paired, phase }))]) {
    const label = adbLabel(state);
    assert.ok(Object.hasOwn(en, label), label); assert.ok(Object.hasOwn(zh, label), label);
  }
});
test('ADB input is a local port, not an address, command, decimal or shell expression', () => {
  for (const value of ['1', '65535', ' 32000 ']) assert.equal(adbPort(value), Number(value.trim()));
  for (const value of ['', '0', '65536', '-1', '127.0.0.1:32000', '32.5', '1e3', '32000;id', 'NaN', '１２３']) assert.equal(adbPort(value), undefined);
});
test('ADB error codes have bilingual messages and unknown native errors are not echoed', () => {
  for (const message of [...Object.values(adbErrors), adbError('raw secret from a transport')]) {
    assert.ok(Object.hasOwn(en, message), message); assert.ok(Object.hasOwn(zh, message), message);
  }
  assert.equal(adbError('raw secret from a transport'), 'ADB operation failed.');
});
