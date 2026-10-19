import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import type { Colors } from './theme';
import { type } from './type';

/** Copies a whole block and confirms in place; used by code fences and tables. */
export function CopyButton({ text, c, label = '复制' }: { text: string; c: Colors; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} onPress={() => { void copy(); }} hitSlop={6} style={({ pressed }) => [s.button, pressed && { opacity: .55 }]}>
    <Icon name={copied ? 'check' : 'copy'} color={c.quiet} size={14} />
    <Text style={[type.micro, { color: c.quiet }]}>{t(copied ? '已复制' : '复制')}</Text>
  </Pressable>;
}

const s = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, minHeight: 32, paddingHorizontal: 4 },
});
