import assert from 'node:assert/strict';
import test from 'node:test';
import { virtualDisplayReady, virtualDisplayLabel, virtualDisplayErrors, virtualDisplayError } from '../src/virtual-display/state.ts';
import { en } from '../src/i18n/en.ts';
import { zh } from '../src/i18n/zh.ts';
const active = { phase: 'running', uid: 2000, displayId: 42, taskId: 17, packageName: 'org.example.fixture', component: 'org.example.fixture/.MainActivity', width: 720, height: 1280, densityDpi: 320, error: null };
test('virtual display readiness requires a real non-primary display, matching app task and shell identity', () => {
  assert.equal(virtualDisplayReady(active), true);
  for (const state of [undefined, { ...active, phase: 'starting' }, { ...active, displayId: 0 }, { ...active, displayId: null }, { ...active, displayId: 1.5 }, { ...active, uid: 0 }, { ...active, taskId: null }, { ...active, packageName: null }, { ...active, component: 'other.app/.Main' }, { ...active, width: 0 }]) assert.equal(virtualDisplayReady(state), false);
});
test('virtual display states and errors have bilingual descriptions without echoing native failures', () => {
  const labels = [undefined, ...['stopped','starting','running','stopping','error','unsupported'].map(phase => ({ ...active, phase }))].map(virtualDisplayLabel);
  for (const message of [...labels, ...Object.values(virtualDisplayErrors)]) {
    assert.ok(Object.hasOwn(en, message), message); assert.ok(Object.hasOwn(zh, message), message);
  }
  assert.equal(virtualDisplayError('arbitrary native output'), 'The virtual display controller failed.');
});
