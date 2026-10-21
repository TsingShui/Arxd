import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarketSearch, parseMarketSkill } from '../src/workspace/market.ts';
import { setActiveLocale } from '../src/i18n/base.ts';

// Market messages are translated; assert against the English catalog.
setActiveLocale('en');

const skill = (overrides = {}) => `---\nname: example\ndescription: Example skill\n---\n\n# Example\n${overrides.body ?? ''}`;
const file = (path, contents = 'x') => ({ path, contents });
const payload = (files, hash) => ({ files, ...(hash ? { hash } : {}) });

test('catalog entries are sanitized and unknown records are dropped', () => {
  const items = parseMarketSearch({ skills: [
    { id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 214047 },
    { id: 'anthropics/skills/docx', installs: 'many' },
    { id: '../../etc/passwd', name: 'bad' },
    { id: 'vercel-labs/skills/find-skills', name: '', installs: -3 },
    { id: 'anthropics/skills/pdf', name: 'duplicate' },
    null,
  ] });
  assert.deepEqual(items.map((item) => item.id), ['anthropics/skills/pdf', 'anthropics/skills/docx', 'vercel-labs/skills/find-skills']);
  assert.equal(items[0].url, 'https://skills.sh/anthropics/skills/pdf');
  assert.equal(items[0].installs, 214047);
  assert.equal(items[1].name, 'docx', 'A missing label falls back to the slug');
  assert.equal(items[2].name, 'find-skills', 'An empty label also falls back to the slug');
  assert.equal(items[1].installs, 0, 'A non-numeric install count becomes zero');
  assert.equal(items[1].source, 'anthropics/skills');
});

test('an unexpected catalog shape is refused instead of rendered', () => {
  for (const value of [null, {}, { skills: 'nope' }, { skills: {} }]) {
    assert.throws(() => parseMarketSearch(value), /unexpected response/);
  }
});

test('a registry payload becomes a bounded flat file list', () => {
  const parsed = parseMarketSkill(payload([
    file('SKILL.md', skill()),
    file('reference/guide.md', '# Guide'),
    file('.DS_Store', 'junk'),
    file('../escape.md', 'no'),
    file('/abs.md', 'no'),
    file('dup.md', 'a'),
    file('dup.md', 'b'),
  ], 'a'.repeat(64)), 'anthropics/skills/pdf');
  assert.deepEqual(parsed.files.map((entry) => entry.path), ['SKILL.md', 'reference/guide.md', 'dup.md']);
  assert.equal(parsed.source, 'anthropics/skills');
  assert.equal(parsed.marketHash, 'a'.repeat(64));
});

test('a single wrapper directory is removed so SKILL.md sits at the root', () => {
  const parsed = parseMarketSkill(payload([file('my-skill/SKILL.md', skill()), file('my-skill/scripts/run.py', 'print(1)')]), 'owner/repo/my-skill');
  assert.deepEqual(parsed.files.map((entry) => entry.path), ['SKILL.md', 'scripts/run.py']);
});

test('unusable market skills are refused before any bytes are written', () => {
  for (const [label, value] of [
    ['no files', { files: [] }],
    ['not an array', { files: 'nope' }],
    ['no manifest', payload([file('readme.md')])],
    ['two wrapper roots', payload([file('a/SKILL.md', skill()), file('b/readme.md')])],
    ['non-text contents', { files: [{ path: 'SKILL.md' }] }],
    ['too many files', payload(Array.from({ length: 200 }, (_, index) => file(`f-${index}.md`)))],
    ['oversized file', payload([file('SKILL.md', skill()), file('big.bin', 'x'.repeat(1024 * 1024 + 1))])],
    ['total over budget', payload([file('SKILL.md', skill()), file('a.bin', 'x'.repeat(1024 * 1024)), file('b.bin', 'y'.repeat(1024 * 1024 + 1))])],
  ]) {
    assert.throws(() => parseMarketSkill(value, 'owner/repo/skill'), /market|skill|SKILL|files|MiB/i, label);
  }
  assert.throws(() => parseMarketSkill(payload([file('SKILL.md', skill())]), '../../bad'), /identifier/);
});
