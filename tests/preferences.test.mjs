import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arxdInstructions, SAFETY_INSTRUCTIONS } from '../src/agent/instructions.ts';
import { PINNED_MODEL_ID } from '../src/agent/local-provider.ts';
import { MAX_IMPORT_BYTES, MIN_IMPORT_BYTES } from '../src/workspace/limits.ts';
import { appearanceOf, importLimitOf, instructionText, rememberedThinking, selectModelPreference } from '../src/workspace/preferences.ts';

const preferences = (values = {}) => ({ palette: 'fire', active: null, conversations: [], ...values });

test('appearance defaults distinguish a new workspace from legacy palette-only preferences', () => {
  assert.equal(appearanceOf(undefined), 'system');
  assert.equal(appearanceOf(preferences()), 'dark');
  assert.equal(appearanceOf(preferences({ palette: 'spring' })), 'light');
  for (const appearance of ['system', 'light', 'dark']) {
    for (const palette of ['fire', 'spring']) assert.equal(appearanceOf(preferences({ palette, appearance })), appearance);
  }
});

test('invalid stored import limits fall back to the ceiling, not a smaller implicit budget', () => {
  assert.equal(importLimitOf(undefined), MAX_IMPORT_BYTES);
  for (const importLimit of [undefined, null, '1048576', NaN, Infinity, -Infinity, 0, MIN_IMPORT_BYTES - 1, MIN_IMPORT_BYTES + 0.5, MAX_IMPORT_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(importLimitOf(preferences({ importLimit })), MAX_IMPORT_BYTES, String(importLimit));
  }
  for (const importLimit of [MIN_IMPORT_BYTES, MIN_IMPORT_BYTES + 1, MAX_IMPORT_BYTES]) {
    assert.equal(importLimitOf(preferences({ importLimit })), importLimit);
  }
});

test('thinking is remembered per model with a same-model legacy fallback and supported-level validation', () => {
  const stored = preferences({ model: 'cloud-a', thinking: 'high', thinkingByModel: { 'cloud-a': 'low', 'cloud-b': 'high' } });
  const before = structuredClone(stored);
  assert.equal(rememberedThinking(stored, 'cloud-a', ['off', 'low', 'high']), 'low');
  assert.equal(rememberedThinking(stored, 'cloud-b', ['off', 'high']), 'high');
  assert.equal(rememberedThinking(stored, 'new-model', ['off', 'high']), 'off');
  assert.equal(rememberedThinking(stored, 'cloud-a', ['off', 'high']), 'high');
  assert.equal(rememberedThinking(stored, 'cloud-b', ['off']), 'off');
  assert.equal(rememberedThinking(stored, undefined, ['off']), 'off');
  assert.equal(rememberedThinking(undefined, 'new-model', ['low', 'high']), 'low');
  assert.deepEqual(stored, before);
});

test('model selection materializes the legacy thinking level before changing its owner without overwriting a cached choice', () => {
  for (const thinking of ['off', 'high']) {
    const stored = preferences({ model: 'cloud-a', thinking });
    // The workspace resolves the target level before committing the model switch.
    assert.equal(rememberedThinking(stored, 'cloud-b', ['off', 'high']), 'off');
    selectModelPreference(stored, 'cloud-b');
    assert.equal(stored.model, 'cloud-b');
    assert.equal(stored.testModelMigrated, true);
    assert.deepEqual(stored.thinkingByModel, { 'cloud-a': thinking });
    assert.equal(rememberedThinking(stored, 'cloud-a', ['off', 'high']), thinking);
  }
  const cached = preferences({ model: 'cloud-a', thinking: 'high', thinkingByModel: { 'cloud-a': 'low', other: 'off' } });
  selectModelPreference(cached, 'cloud-b');
  assert.deepEqual(cached.thinkingByModel, { 'cloud-a': 'low', other: 'off' });
  const same = preferences({ model: 'cloud-a', thinking: 'high' });
  selectModelPreference(same, 'cloud-a');
  assert.equal(same.thinkingByModel, undefined);
});

test('cloud and local instructions select independent profiles, retain the safety preamble and ignore the test provider', () => {
  const stored = preferences({ activePromptCloud: 'cloud', activePromptLocal: 'local', promptProfiles: [
    { id: 'cloud', name: 'Cloud', text: '  CLOUD_FIXTURE  ', updatedAt: 1 },
    { id: 'local', name: 'Local', text: 'LOCAL_FIXTURE', updatedAt: 2 },
  ] });
  const before = structuredClone(stored);
  assert.equal(instructionText('cloud-a', stored), `${SAFETY_INSTRUCTIONS}\n\nCLOUD_FIXTURE`);
  for (const id of [PINNED_MODEL_ID, 'gguf-0123456789abcdef']) assert.equal(instructionText(id, stored), `${SAFETY_INSTRUCTIONS}\n\nLOCAL_FIXTURE`);
  assert.equal(instructionText('test', stored), undefined);
  assert.equal(instructionText(undefined, stored), undefined);
  assert.equal(instructionText('cloud-a', undefined), arxdInstructions(false));
  assert.equal(instructionText(PINNED_MODEL_ID, undefined), arxdInstructions(true));
  assert.deepEqual(stored, before);
});

test('default, missing and blank prompt selections keep the built-in body for that model class', () => {
  for (const active of [null, 'missing', 'blank']) {
    const stored = preferences({ activePromptCloud: active, activePromptLocal: active, promptProfiles: [{ id: 'blank', name: 'Blank', text: ' \n ', updatedAt: 1 }] });
    assert.equal(instructionText('cloud-a', stored), arxdInstructions(false));
    assert.equal(instructionText(PINNED_MODEL_ID, stored), arxdInstructions(true));
  }
});
