import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';
import { type } from './type';

/**
 * Renders the small Markdown subset Agent answers actually use: fenced code,
 * headings, bullet and numbered lists, quotes, plus inline code and bold.
 * Everything stays inside RN Text nodes so answers remain selectable and flow
 * naturally; inline code therefore gets a monospace tint rather than a padded
 * pill, which Text cannot lay out on Android.
 */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

function inline(text: string, c: Colors, key: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <Text key={`${key}-${index}`} style={[s.inlineCode, { color: c.heading, backgroundColor: c.code }]}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <Text key={`${key}-${index}`} style={s.bold}>{part.slice(2, -2)}</Text>;
    }
    return <Text key={`${key}-${index}`}>{part}</Text>;
  });
}

export function RichText({ content, c, caret }: { content: string; c: Colors; caret?: ReactNode }) {
  const pieces = content.split(/```[^\n]*\n?([\s\S]*?)```/g);
  const blocks: ReactNode[] = [];

  pieces.forEach((piece, pieceIndex) => {
    if (pieceIndex % 2 === 1) {
      const code = piece.replace(/\n$/, '');
      if (code.trim()) {
        blocks.push(
          <View key={`code-${pieceIndex}`} style={[s.codeFrame, { backgroundColor: c.code, borderColor: c.line }]}>
            <Text selectable style={[s.code, { color: c.text }]}>{code}</Text>
          </View>,
        );
      }
      return;
    }

    piece.split(/\n{2,}/).filter((block) => block.trim()).forEach((block, blockIndex) => {
      const key = `b-${pieceIndex}-${blockIndex}`;
      const lines = block.split('\n').filter((line) => line.trim());
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
      if (heading) {
        const level = Math.min(heading[1].length, 3);
        blocks.push(
          <Text key={key} selectable style={[level === 1 ? s.h1 : level === 2 ? s.h2 : s.h3, { color: c.heading }]}>
            {inline(heading[2], c, key)}
          </Text>,
        );
        return;
      }
      if (lines.every((line) => /^>\s?/.test(line))) {
        blocks.push(
          <View key={key} style={[s.quote, { borderLeftColor: c.accentLine }]}>
            <Text selectable style={[s.quoteText, { color: c.quiet }]}>
              {inline(lines.map((line) => line.replace(/^>\s?/, '')).join(' '), c, key)}
            </Text>
          </View>,
        );
        return;
      }
      if (lines.every((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line))) {
        blocks.push(
          <View key={key} style={s.list}>
            {lines.map((line, index) => {
              const ordered = /^\s*(\d+[.)])\s+/.exec(line);
              const body = line.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
              return (
                <View key={`${key}-${index}`} style={s.listRow}>
                  <Text style={[s.listMark, { color: c.accent }]}>{ordered ? ordered[1] : '·'}</Text>
                  <Text selectable style={[s.paragraph, { color: c.text }]}>{inline(body, c, `${key}-${index}`)}</Text>
                </View>
              );
            })}
          </View>,
        );
        return;
      }
      blocks.push(
        <Text key={key} selectable style={[s.paragraph, { color: c.text }]}>{inline(lines.join('\n'), c, key)}</Text>,
      );
    });
  });

  const last = blocks.length - 1;
  return (
    <View>
      {caret && last >= 0
        ? blocks.map((block, index) => (index === last ? <View key={`wrap-${index}`}>{block}{caret}</View> : block))
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
  inlineCode: { ...type.mono, fontSize: 13, lineHeight: 21 },
  codeFrame: { borderWidth: 1, borderRadius: 12, padding: 13, marginBottom: 14 },
  code: { ...type.code },
  quote: { borderLeftWidth: 2, paddingLeft: 11, marginBottom: 14 },
  quoteText: { ...type.caption },
  list: { marginBottom: 14, gap: 6 },
  listRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  listMark: { ...type.body, minWidth: 12 },
});
