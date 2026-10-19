import { useMemo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CodeBlock } from './CodeText';
import { CopyButton } from './CopyButton';
import { displayWidth, parseMarkdown, plainText, type Inline, type ListItem, type MarkdownBlock, type TableAlignment } from './markdown';
import type { Colors } from './theme';
import { type } from './type';

/**
 * Renders the parsed Markdown model. Text, headings, lists and quotes stay
 * inside RN Text nodes so answers remain selectable and flow naturally; fenced
 * code and content-sized tables scroll horizontally because Text cannot lay them
 * out on Android. Links are styled but never tappable, and raw HTML arrives here
 * as literal text.
 */
function inline(nodes: Inline[], c: Colors, key: string): ReactNode[] {
  return nodes.map((node, index) => {
    const id = `${key}-${index}`;
    switch (node.kind) {
      case 'text': return <Text key={id}>{node.text}</Text>;
      case 'code': return <Text key={id} style={[s.inlineCode, { color: c.heading, backgroundColor: c.code }]}>{node.text}</Text>;
      case 'strong': return <Text key={id} style={s.bold}>{inline(node.children, c, id)}</Text>;
      case 'em': return <Text key={id} style={s.italic}>{inline(node.children, c, id)}</Text>;
      case 'del': return <Text key={id} style={s.strike}>{inline(node.children, c, id)}</Text>;
      case 'link': return <Text key={id} style={[s.link, { color: c.accent }]}>{inline(node.children, c, id)}</Text>;
      case 'image': return <Text key={id} style={{ color: c.faint }}>{`[${node.alt}]`}</Text>;
      case 'br': return <Text key={id}>{'\n'}</Text>;
    }
  });
}

/** Columns are sized from their longest cell; the table scrolls instead of wrapping into noise. */
function columnWidth(header: Inline[][], rows: Inline[][][], column: number) {
  const longest = Math.max(displayWidth(plainText(header[column] ?? [])), ...rows.map((row) => displayWidth(plainText(row[column] ?? []))));
  return Math.min(280, Math.max(96, Math.round(longest * 7.4) + 26));
}

function table(block: Extract<MarkdownBlock, { kind: 'table' }>, c: Colors, key: string) {
  const widths = block.header.map((_, column) => columnWidth(block.header, block.rows, column));
  const textAlign = (column: number): TableAlignment => block.align[column] ?? 'left';
  const tsv = [block.header, ...block.rows].map((row) => row.map((cell) => plainText(cell)).join('\t')).join('\n');
  return (
    <View key={key}>
      <View style={s.tableTools}><CopyButton text={tsv} c={c} label="复制表格" /></View>
      <ScrollView horizontal style={s.tableScroll} contentContainerStyle={s.tableContent} showsHorizontalScrollIndicator={false}>
        <View style={[s.table, { borderColor: c.line }]}>
          {[block.header, ...block.rows].map((row, rowIndex) => (
            <View key={`${key}-r${rowIndex}`} style={[s.tableRow, rowIndex === 0 ? { backgroundColor: c.raised } : { borderTopWidth: 1, borderTopColor: c.line }]}>
              {row.map((cell, column) => (
                <View key={`${key}-r${rowIndex}-c${column}`} style={[s.tableCell, { width: widths[column] }, column > 0 && { borderLeftWidth: 1, borderLeftColor: c.line }]}>
                  <Text selectable style={[s.tableText, { color: rowIndex === 0 ? c.heading : c.text, textAlign: textAlign(column) }, rowIndex === 0 && s.bold]}>
                    {inline(cell, c, `${key}-r${rowIndex}-c${column}`)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function listItem(item: ListItem, ordered: boolean, start: number, index: number, c: Colors, key: string): ReactNode {
  const mark = item.task ? (item.checked ? '☑' : '☐') : ordered ? `${start + index}.` : '·';
  return (
    <View key={key} style={s.listItem}>
      <View style={s.listRow}>
        <Text style={[s.listMark, { color: item.task && item.checked ? c.accent : c.quiet }]}>{mark}</Text>
        <Text selectable style={[s.paragraph, { color: c.text, marginBottom: 0 }]}>{inline(item.content, c, key)}</Text>
      </View>
      {item.children.map((child, childIndex) => block(child, c, `${key}-${childIndex}`))}
    </View>
  );
}

function block(value: MarkdownBlock, c: Colors, key: string): ReactNode {
  switch (value.kind) {
    case 'code':
      return (
        <View key={key} style={[s.codeFrame, { backgroundColor: c.code, borderColor: c.line }]}>
          <CodeBlock code={value.text} language={value.lang} c={c} copyable />
        </View>
      );
    case 'heading': {
      const level = Math.min(value.level, 3);
      return (
        <Text key={key} selectable style={[level === 1 ? s.h1 : level === 2 ? s.h2 : s.h3, { color: c.heading }]}>
          {inline(value.content, c, key)}
        </Text>
      );
    }
    case 'quote':
      return (
        <View key={key} style={[s.quote, { borderLeftColor: c.accentLine }]}>
          {value.blocks.map((child, index) => block(child, c, `${key}-${index}`))}
        </View>
      );
    case 'list':
      return (
        <View key={key} style={s.list}>
          {value.items.map((item, index) => listItem(item, value.ordered, value.start, index, c, `${key}-${index}`))}
        </View>
      );
    case 'rule':
      return <View key={key} style={[s.rule, { backgroundColor: c.line }]} />;
    case 'table':
      return table(value, c, key);
    case 'paragraph':
      return <Text key={key} selectable style={[s.paragraph, { color: c.text }]}>{inline(value.content, c, key)}</Text>;
  }
}

export function RichText({ content, c, caret }: { content: string; c: Colors; caret?: ReactNode }) {
  // Streaming rerenders the same growing answer; parsing once per content change
  // keeps table detection off the token path.
  const blocks = useMemo(() => parseMarkdown(content).map((value, index) => block(value, c, `b-${index}`)), [content, c]);
  const last = blocks.length - 1;
  return (
    <View>
      {caret && last >= 0
        ? blocks.map((value, index) => (index === last ? <View key={`wrap-${index}`}>{value}{caret}</View> : value))
        : blocks}
      {caret && last < 0 ? <View>{caret}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  paragraph: { ...type.body, marginBottom: 14 },
  h1: { ...type.title, marginBottom: 12 },
  h2: { ...type.heading, marginBottom: 10 },
  h3: { ...type.section, marginBottom: 8 },
  bold: { fontWeight: '600' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  inlineCode: { ...type.mono, fontSize: 13, lineHeight: 21 },
  codeFrame: { borderWidth: 1, borderRadius: 12, padding: 13, marginBottom: 14 },
  quote: { borderLeftWidth: 2, paddingLeft: 11, marginBottom: 14 },
  list: { marginBottom: 14, gap: 6 },
  listItem: { gap: 6 },
  listRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  listMark: { ...type.body, minWidth: 16 },
  rule: { height: 1, marginTop: 4, marginBottom: 18 },
  tableTools: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 4 },
  tableScroll: { marginBottom: 16 },
  tableContent: { paddingRight: 4 },
  table: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', alignItems: 'stretch' },
  tableCell: { paddingVertical: 8, paddingHorizontal: 11, justifyContent: 'center' },
  tableText: { ...type.caption, lineHeight: 20 },
});
