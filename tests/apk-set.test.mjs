import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentFiles, importedAppFiles, validateApkSet } from '../src/workspace/apk-set.ts';

const file = (id, overrides = {}) => ({
  id, name: `${id}.apk`, uri: `file:///captures/${id}.apk`, size: 1024, sha256: 'a'.repeat(64),
  source: null, format: 'APK', ...overrides,
});
const BASE = 'a1b2c3d4';
const SPLIT = 'd4c3b2a1';
const app = (files, overrides = {}) => ({ packageName: 'com.example.app', label: 'Example', versionName: '1.2.3',
  versionCode: '10203', files, ...overrides });

test('an imported application publishes one ordered base-plus-split set', () => {
  const [base, split] = importedAppFiles(app([file(BASE), file(SPLIT)]));
  assert.equal(base.id, BASE);
  assert.deepEqual(base.apkSet, { packageName: 'com.example.app', label: 'Example', versionName: '1.2.3',
    versionCode: '10203', fileIds: [BASE, SPLIT] });
  assert.equal(split.apkSet, undefined, 'Only the base attachment owns the set');
  validateApkSet(base);
});

test('malformed application imports are refused before any capture is registered', () => {
  for (const [label, value] of [
    ['no files', app([])],
    ['too many parts', app(Array.from({ length: 129 }, (_, index) => file(`a${String(index).padStart(7, '0')}`)))],
    ['non-APK part', app([file(BASE), file(SPLIT, { format: 'DEX' })])],
    ['readable source', app([file(BASE, { source: 'code' })])],
    ['nested set', app([file('a', { apkSet: { packageName: 'com.example.app', label: 'x', versionName: null, versionCode: '1', fileIds: ['a'] } })])],
    ['bytes over the ceiling', app([file(BASE, { size: 8 * 1024 * 1024 * 1024 + 1 })])],
    ['invalid package', app([file(BASE)], { packageName: '../escape' })],
    ['invalid version code', app([file(BASE)], { versionCode: 'v1' })],
  ]) {
    assert.throws(() => importedAppFiles(value), /Invalid/, label);
  }
});

test('a forged set cannot claim another base or duplicate members', () => {
  const set = { packageName: 'com.example.app', label: 'Example', versionName: null, versionCode: '1', fileIds: [BASE] };
  for (const [label, overrides] of [
    ['base mismatch', { fileIds: ['other-id'] }],
    ['duplicate member', { fileIds: [BASE, BASE] }],
    ['no members', { fileIds: [] }],
    ['too many members', { fileIds: Array.from({ length: 129 }, () => BASE) }],
    ['bad member id', { fileIds: [BASE, 'not an id'] }],
    ['bad package', { packageName: 'com/example' }],
    ['bad version code', { versionCode: '1.0' }],
  ]) {
    assert.throws(() => validateApkSet(file(BASE, { apkSet: { ...set, ...overrides } })), /Invalid APK set/, label);
  }
});

test('resolution requires every member and reuses only non-set APK captures', async () => {
  const primary = importedAppFiles(app([file(BASE), file(SPLIT)]))[0];
  const resolved = await attachmentFiles(primary, async (id) => id === SPLIT ? file(SPLIT) : undefined);
  assert.deepEqual(resolved.map((entry) => entry.id), [BASE, SPLIT]);
  await assert.rejects(attachmentFiles(primary, async () => undefined));
  await assert.rejects(attachmentFiles(primary, async () => file(SPLIT, { apkSet: {} })));
  assert.deepEqual((await attachmentFiles(file('abcdef01'), async () => undefined)).map((entry) => entry.id), ['abcdef01'],
    'A single non-set capture needs no resolution');
});
