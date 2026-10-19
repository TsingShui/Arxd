import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayWidth, parseMarkdown, plainText } from '../src/ui/markdown.ts';

const text = (nodes) => plainText(nodes);

function flatten(blocks) {
  return blocks.map((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph': return text(block.content);
      case 'quote': return flatten(block.blocks);
      case 'list': return block.items.map((item) => `${text(item.content)} ${flatten(item.children)}`).join(' ');
      case 'code': return block.text;
      case 'rule': return '';
      case 'table': return [block.header, ...block.rows].map((row) => row.map(text).join(' ')).join(' ');
    }
  }).join('\n');
}

test('headings, soft line breaks and horizontal rules keep every line', () => {
  const blocks = parseMarkdown('# 一\n\n标题二\n===\n\n第一行\n第二行\n\n---\n\n收尾');
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'heading', 'paragraph', 'rule', 'paragraph']);
  assert.equal(blocks[0].level, 1);
  assert.equal(text(blocks[0].content), '一');
  assert.equal(blocks[1].level, 1);
  assert.equal(text(blocks[1].content), '标题二');
  assert.equal(text(blocks[2].content), '第一行\n第二行');
  assert.equal(text(blocks[4].content), '收尾');
});

test('GFM tables keep alignment, escaped pipes, emphasis and short rows', () => {
  const [table] = parseMarkdown('| 左 | 中 | 右 |\n|:--|:-:|--:|\n| a\\|b | **c** | 1 |\n| 短 |');
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.deepEqual(table.header.map(text), ['左', '中', '右']);
  assert.deepEqual(table.rows.map((row) => row.map(text)), [['a|b', 'c', '1'], ['短', '', '']]);
  assert.ok(table.rows[0][1].some((node) => node.kind === 'strong'), 'cell emphasis survives parsing');
  assert.ok(table.rows[0][0].every((node) => node.kind === 'text'), 'escaped pipe stays literal text');
});

test('task lists and nested lists keep their structure', () => {
  const [list] = parseMarkdown('- [ ] 待办\n- [x] 完成\n- 外层\n  - 内层');
  assert.equal(list.kind, 'list');
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map((item) => text(item.content)), ['待办', '完成', '外层']);
  assert.deepEqual(list.items.slice(0, 2).map((item) => [item.task, item.checked]), [[true, false], [true, true]]);
  assert.equal(list.items[2].task, undefined);
  assert.equal(list.items[2].children.length, 1);
  const [nested] = list.items[2].children;
  assert.equal(nested.kind, 'list');
  assert.deepEqual(nested.items.map((item) => text(item.content)), ['内层']);
});

test('links are styled nodes without navigation, images become alt text and HTML stays literal', () => {
  const [paragraph] = parseMarkdown('见 [文档](https://example.test) 和 ![截图](a.png) <b>粗</b>');
  assert.equal(paragraph.kind, 'paragraph');
  const nodes = paragraph.content;
  const link = nodes.find((node) => node.kind === 'link');
  assert.ok(link, 'link node exists');
  assert.equal(link.href, 'https://example.test');
  assert.equal(text(link.children), '文档');
  const image = nodes.find((node) => node.kind === 'image');
  assert.ok(image, 'image alt is rendered as a node');
  assert.equal(image.alt, '截图');
  assert.match(text(nodes), /<b>粗<\/b>/, 'raw HTML is preserved as literal text');
});

test('fenced and indented code blocks are separate and keep exact bytes', () => {
  const blocks = parseMarkdown('前言\n\n```js\nconst a = `x`;\n```\n\n    indented line\n    second\n\n```\n未闭合');
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'code', 'code', 'code']);
  assert.equal(blocks[1].text, 'const a = `x`;');
  assert.equal(blocks[1].lang, 'js');
  assert.equal(blocks[2].text, 'indented line\nsecond');
  assert.equal(blocks[3].text, '未闭合');
});

test('an agent-shaped answer never loses its text', () => {
  const source = [
    '## 结论', '', '样本含 **3** 个可疑点，见 `check()`。', '',
    '- [x] 已确认签名', '- [ ] 待确认权限', '  1. 子项一', '  2. 子项二', '',
    '| 项 | 说明 |', '| --- | --- |', '| A | 读取通讯录 |', '',
    '> 引用结论', '', '```text', 'raw output ✓', '```', '',
    '参考 [报告](https://example.test/r)。', '', '---', '', '结束',
  ].join('\r\n');
  const blocks = parseMarkdown(source);
  const content = flatten(blocks);
  for (const needle of ['结论', '3', 'check()', '已确认签名', '待确认权限', '子项一', '子项二', '读取通讯录', '引用结论', 'raw output ✓', '报告', '结束']) {
    assert.ok(content.includes(needle), `missing ${needle}`);
  }
  assert.equal(blocks.filter((block) => block.kind === 'rule').length, 1);
});

test('display width counts CJK, fullwidth and emoji as two columns', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中a'), 3);
  assert.equal(displayWidth('（全角）'), 8);
  assert.equal(displayWidth('📱'), 2);
});

test('hostile nesting depth stays bounded without losing text', () => {
  const deepList = Array.from({ length: 14 }, (_, index) => `${'  '.repeat(index)}- 层级${index}`).join('\n');
  const list = flatten(parseMarkdown(deepList));
  assert.match(list, /层级0/);
  assert.match(list, /层级13/);
  const deepQuote = `${'> '.repeat(12)}最内层`;
  assert.match(flatten(parseMarkdown(deepQuote)), /最内层/);
  const deepEmphasis = `${'**'.repeat(12)}粗${'**'.repeat(12)}`;
  assert.match(flatten(parseMarkdown(deepEmphasis)), /粗/);
});

test('underscore emphasis follows CommonMark and leaves snake_case alone', () => {
  const [paragraph] = parseMarkdown('_斜体_ __粗体__ snake_case_name a_b_ __init__');
  const nodes = paragraph.content;
  assert.equal(text(nodes), '斜体 粗体 snake_case_name a_b_ init');
  assert.equal(nodes.find((node) => node.kind === 'em')?.children[0].text, '斜体');
  assert.equal(nodes.filter((node) => node.kind === 'strong').map((node) => text(node.children)).join(','), '粗体,init');
  assert.ok(text(nodes).includes('snake_case_name') && text(nodes).includes('a_b_'));
});

test('task lists nest ordered lists and keep three levels', () => {
  const [list] = parseMarkdown('- [x] 完成\n  - 子项\n    1. 深入\n- [ ] 待办');
  assert.deepEqual(list.items.map((item) => [text(item.content), item.checked]), [['完成', true], ['待办', false]]);
  const [sub] = list.items[0].children;
  assert.equal(sub.kind, 'list');
  const [ordered] = sub.items[0].children;
  assert.equal(ordered.kind, 'list');
  assert.equal(ordered.ordered, true);
  assert.deepEqual(ordered.items.map((item) => text(item.content)), ['深入']);
});
