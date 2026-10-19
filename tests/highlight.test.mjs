import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightCode, languageForFile } from '../src/ui/highlight.ts';

const text = (tokens) => tokens.map((token) => token.text).join('');

test('javascript keeps every byte and distinguishes comments, strings, keywords and numbers', () => {
  const source = '// note\nconst answer = "forty-two" + 42;\nfunction run() { return answer; }\n';
  const tokens = highlightCode(source, 'javascript');
  assert.equal(text(tokens), source);
  const tones = new Set(tokens.map((token) => token.tone));
  for (const tone of ['comment', 'string', 'keyword', 'number', 'title']) assert.ok(tones.has(tone), `missing ${tone}`);
  assert.ok(tokens.filter((token) => token.tone === 'comment').every((token) => token.text.startsWith('//')));
});

test('fenced languages use aliases and unknown or plain fences stay uncoloured', () => {
  assert.ok(highlightCode('const x = 1;', 'ts').some((token) => token.tone === 'keyword'));
  assert.ok(highlightCode('SELECT 1;', 'sql').some((token) => token.tone === 'keyword'));
  assert.ok(highlightCode('<manifest/>', 'xml').some((token) => token.tone === 'keyword'));
  for (const language of ['text', 'plain', 'console', '', undefined, 'no-such-language']) {
    assert.deepEqual(highlightCode('const x = 1;', language), [{ text: 'const x = 1;', tone: 'plain' }]);
  }
});

test('json and csharp keep their structure while content is preserved exactly', () => {
  const json = '{"ok": true, "count": 3, "path": "a/b"}';
  assert.equal(text(highlightCode(json, 'json')), json);
  assert.ok(highlightCode(json, 'json').some((token) => token.tone === 'string'));
  const csharp = 'public class Probe { void Run() { } }';
  const tokens = highlightCode(csharp, 'cs');
  assert.equal(text(tokens), csharp);
  assert.ok(tokens.some((token) => token.tone === 'keyword'));
});

test('oversized code is never highlighted', () => {
  const source = `// ${'x'.repeat(20_001)}`;
  assert.deepEqual(highlightCode(source, 'javascript'), [{ text: source, tone: 'plain' }]);
});

test('file names map to grammars without guessing unknown extensions', () => {
  assert.equal(languageForFile('src/app.tsx'), 'typescript');
  assert.equal(languageForFile('main.mjs'), 'javascript');
  assert.equal(languageForFile('decompiled/Main.java'), 'java');
  assert.equal(languageForFile('AndroidManifest.xml'), 'xml');
  assert.equal(languageForFile('notes.toml'), 'ini');
  assert.equal(languageForFile('main.rs'), 'rust');
  assert.equal(languageForFile('SKILL.md'), 'markdown');
  assert.equal(languageForFile('archive.apk'), undefined);
  assert.equal(languageForFile('.gitignore'), undefined);
  assert.equal(languageForFile('Makefile'), undefined);
});
