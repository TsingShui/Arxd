import { requireNativeViewManager } from 'expo-modules-core';
import { useDeferredValue, useMemo, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { highlightCode } from './highlight';
import type { Colors } from './theme';

/** Native Android span editor; JS only supplies colours, so IME and selection stay native. */
type NativeProps = {
  text: string;
  spans: string;
  textColor: string;
  editable: boolean;
  maxLength: number;
  wrap: boolean;
  label: string;
  onChangeText?: (event: { nativeEvent: { value: string } }) => void;
  style?: StyleProp<ViewStyle>;
};
const NativeCodeEditor = requireNativeViewManager<NativeProps>('ArxdRxd', 'CodeEditor');

const MAX_HIGHLIGHT_CHARS = 20_000;
const MAX_SPANS = 2_000;

/** Highlighting larger edits would serialize thousands of spans on every pause. */
function spansFor(text: string, language: string | undefined, c: Colors): string {
  if (text.length > MAX_HIGHLIGHT_CHARS) return '[]';
  const spans: [number, number, string][] = [];
  let offset = 0;
  for (const token of highlightCode(text, language)) {
    const end = offset + token.text.length;
    if (token.tone !== 'plain' && token.text.trim()) spans.push([offset, end, c.syntax[token.tone]]);
    offset = end;
    if (spans.length >= MAX_SPANS) break;
  }
  return JSON.stringify(spans);
}

export function CodeEditor({ text, language, c, editable = true, maxLength = 262144, wrap = language === 'markdown', label = '', onChangeText, style }: {
  text: string; language?: string; c: Colors; editable?: boolean; maxLength?: number; wrap?: boolean; label?: string;
  onChangeText?: (value: string) => void; style?: StyleProp<ViewStyle>;
}) {
  const [value, setValue] = useState(text);
  // Deferral keeps typing responsive while colours catch up after a short pause.
  const deferred = useDeferredValue(value);
  const spans = useMemo(() => spansFor(deferred, language, c), [deferred, language, c]);
  return (
    <NativeCodeEditor
      text={text}
      spans={spans}
      textColor={c.text}
      editable={editable}
      maxLength={maxLength}
      wrap={wrap}
      label={label}
      onChangeText={(event) => { const next = event.nativeEvent.value; setValue(next); onChangeText?.(next); }}
      style={[{ backgroundColor: c.code }, style]}
    />
  );
}
