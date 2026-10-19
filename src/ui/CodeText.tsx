import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { CopyButton } from './CopyButton';
import { highlightCode } from './highlight';
import type { Colors } from './theme';
import { type } from './type';

/**
 * Read-only code with syntax colours. Editing stays inside a plain TextInput:
 * RN cannot style spans while keeping IME composition and selection native.
 */
export function CodeText({ code, language, c, selectable = true, style }: {
  code: string; language?: string; c: Colors; selectable?: boolean; style?: StyleProp<TextStyle>;
}) {
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <Text selectable={selectable} style={[s.code, { color: c.text }, style]}>
      {tokens.map((token, index) => token.tone === 'plain'
        ? <Text key={index}>{token.text}</Text>
        : <Text key={index} style={{ color: c.syntax[token.tone] }}>{token.text}</Text>)}
    </Text>
  );
}

/**
 * Code does not soft-wrap: long lines scroll horizontally so indentation and
 * column alignment survive. Chat blocks, file previews and raw records share it.
 */
export function CodeBlock({ code, language, c, style, textStyle, copyable = false }: {
  code: string; language?: string; c: Colors; style?: StyleProp<any>; textStyle?: StyleProp<TextStyle>; copyable?: boolean;
}) {
  return (
    <View style={style}>
      {copyable && <View style={s.copyRow}>
        <Text style={[type.micro, { color: c.faint }]}>{(language || 'text').toUpperCase()}</Text>
        <CopyButton text={code} c={c} label="复制代码" />
      </View>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.blockContent}>
        <CodeText code={code} language={language} c={c} style={textStyle} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  code: { ...type.code },
  blockContent: { paddingRight: 12 },
  copyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32, marginBottom: 2 },
});
