import assert from 'node:assert/strict';
import test from 'node:test';
import { splitScreenLabel, splitScreenError } from '../src/split-screen/state.ts';
import { en } from '../src/i18n/en.ts';
import { zh } from '../src/i18n/zh.ts';
const idle = { supported: true, multiWindow: false, packageName: null, requestedAt: null, elapsedMs: null, error: null };
test('split requests never pretend to prove target placement or grant screen access', () => {
  assert.equal(splitScreenLabel(idle), 'Split-screen ready');
  assert.equal(splitScreenLabel({ ...idle, requestedAt: 42, elapsedMs: 100 }), 'Split-screen requested');
  assert.match(splitScreenLabel({ ...idle, requestedAt: 42, elapsedMs: 4000 }), /not confirmed/);
  assert.match(splitScreenLabel({ ...idle, multiWindow: true }), /Confirm the selected app/);
  assert.match(splitScreenLabel({ ...idle, supported: false }), /Android 12L/);
});
test('window status and errors are bilingual and never echo native exceptions', () => {
  for (const key of [splitScreenLabel(), splitScreenLabel(idle), splitScreenLabel({ ...idle, supported: false }),
    splitScreenLabel({ ...idle, multiWindow: true }), splitScreenLabel({ ...idle, requestedAt: 1, elapsedMs: 0 }),
    splitScreenLabel({ ...idle, requestedAt: 1, elapsedMs: 5000 }), ...['unsupported','not_foreground','invalid_app','launch_failed'].map(splitScreenError)]) {
    assert.ok(Object.hasOwn(en, key), key); assert.ok(Object.hasOwn(zh, key), key);
  }
  assert.equal(splitScreenError('secret native exception'), splitScreenError('launch_failed'));
});
