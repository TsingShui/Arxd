import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { activeLocale, languageModeOf, resolveLanguage, resolveLocale, setActiveLocale, tr, translate } from '../src/i18n/base.ts';
import { en } from '../src/i18n/en.ts';
import { zh } from '../src/i18n/zh.ts';
import { legacyKeys } from '../src/i18n/legacy-keys.ts';
import { arxdInstructions } from '../src/agent/instructions.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const chinese = /[\u3400-\u9fff]/;
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

test('explicit language overrides Android and system mode follows supported locales', () => {
  for (const system of ['zh', 'zh-Hans', 'en', 'fr', undefined, null]) {
    assert.equal(resolveLanguage('zh', system), 'zh');
    assert.equal(resolveLanguage('en', system), 'en');
    assert.equal(resolveLanguage('system', system), resolveLocale(system));
  }
  assert.equal(resolveLanguage('system', 'zh-Hant'), 'zh');
  assert.equal(resolveLanguage('system', 'en-US'), 'en');
  for (const stored of [undefined, null, '', 'invalid', 1, {}, 'system']) assert.equal(languageModeOf(stored), 'system');
  for (const stored of ['zh', 'en']) assert.equal(languageModeOf(stored), stored);
});

test('translation preserves placeholders, custom text and non-React locale consumers', () => {
  const previous = activeLocale();
  try {
    setActiveLocale('en');
    assert.equal(tr('Settings'), 'Settings');
    assert.equal(translate('en', '{count} models', { count: 3 }), '3 models');
    assert.equal(translate('zh', '{count} models', { count: 3 }), '3 个模型');
    assert.equal(translate('en', '{count} processes', { count: 3 }), '3 processes');
    assert.equal(translate('zh', '{count} processes', { count: 3 }), '3 个进程');
    assert.equal(translate('en', 'user-provided text 甲'), 'user-provided text 甲');
    assert.equal(translate('en', '请先停止正在运行的任务'), 'Stop the running task first');
    assert.equal(translate('zh', '请先停止正在运行的任务'), '请先停止正在运行的任务');
    assert.equal(translate('en', '未知错误'), '未知错误');
    assert.match(arxdInstructions(), /Answer in English by default/);
    setActiveLocale('zh');
    assert.equal(tr('Settings'), '设置');
    assert.match(arxdInstructions(), /默认用中文回答/);
  } finally { setActiveLocale(previous); }
});

test('English and Chinese catalogs retain all unique keys, source translations and placeholders', () => {
  for (const [file, name] of [['en.ts', 'en'], ['zh.ts', 'zh'], ['legacy-keys.ts', 'legacyKeys']]) {
    const path = join(root, 'src/i18n', file);
    const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    let properties;
    function find(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) properties = node.initializer.properties;
      ts.forEachChild(node, find);
    }
    find(tree);
    assert.ok(properties, `Missing ${name} object literal`);
    const keys = properties.map((property) => property.name?.text).filter((key) => typeof key === 'string');
    assert.equal(new Set(keys).size, keys.length, `Duplicate source properties in ${file}`);
  }
  assert.equal(Object.keys(en).length, 1015);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(new Set(Object.keys(en)).size, Object.keys(en).length);
  for (const [key, value] of Object.entries(en)) {
    assert.equal(chinese.test(value), false, `Non-English catalog value: ${key}`);
    assert.equal(value, key.replace(/ \(\d+\)$/, ''), `Preserve original English output: ${key}`);
    assert.deepEqual(placeholders(zh[key]), placeholders(key.replace(/ \(\d+\)$/, '')), `Chinese placeholders: ${key}`);
    assert.ok(zh[key].trim(), `Empty Chinese translation: ${key}`);
    assert.equal(chinese.test(key), false, `Non-English translation key: ${key}`);
  }
  assert.equal(Object.keys(legacyKeys).length, 952);
  for (const [source, key] of Object.entries(legacyKeys)) {
    assert.equal(zh[key], source, `Preserve exact Chinese source: ${source}`);
    assert.deepEqual(placeholders(en[key]), placeholders(source), `Preserve English placeholders: ${source}`);
  }
});

test('product translation calls and static JSX labels cannot silently fall back to Chinese', () => {
  const untranslated = [];
  const check = (value, location) => { if (chinese.test(value)) untranslated.push(`${location}: ${value}`); };
  function scan(file) {
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const location = `${relative(root, file)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
      if (ts.isCallExpression(node) && ['t', 'tr', 'translate'].includes(node.expression.getText(tree))) {
        const argument = node.arguments[node.expression.getText(tree) === 'translate' ? 1 : 0];
        if (argument) {
          const collect = (child) => { if (ts.isStringLiteralLike(child)) check(child.text, location); else ts.forEachChild(child, collect); };
          collect(argument);
        }
      }
      if (ts.isJsxText(node) && chinese.test(node.text)) untranslated.push(`${location}: ${node.text.trim()}`);
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        if (['label', 'title', 'placeholder', 'accessibilityLabel'].includes(node.name.getText(tree))) check(node.initializer.text, location);
      }
      if (ts.isTemplateExpression(node) && ts.isJsxExpression(node.parent)) {
        const literal = node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
        if (chinese.test(literal)) untranslated.push(`${location}: ${literal}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(file) && !file.endsWith('instructions.ts')) scan(file);
    }
  }
  // Verification screens and user/model/tool output intentionally keep their own
  // text. Instructions have separate locale-aware composition tests above.
  for (const directory of ['src/ui', 'src/workspace', 'src/agent', 'app']) walk(join(root, directory));
  assert.deepEqual(untranslated, [], 'Chinese literals must not remain as translation keys');
});
