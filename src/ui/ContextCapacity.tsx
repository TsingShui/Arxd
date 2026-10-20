import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { useI18n } from '../i18n';
import { unknownCapacity, type ContextCapacity as Capacity } from '../workspace/context-capacity';
import { Icon } from './Icon';
import { MotionModal } from './MotionModal';
import { BusyIndicator } from './BusyIndicator';
import { type } from './type';
import type { Colors } from './theme';

const scale = (value: number) => { const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2; return Number(value.toFixed(digits)); };
const number = (value: number | null) => {
  if (value === null) return '—';
  const rounded = Math.round(value);
  const absolute = Math.abs(rounded);
  if (absolute < 1000) return String(rounded);
  if (absolute < 1_000_000) return `${scale(rounded / 1000)}K`;
  if (absolute < 1_000_000_000) return `${scale(rounded / 1_000_000)}M`;
  return `${scale(rounded / 1_000_000_000)}B`;
};
const PART_LABEL: Record<string, string> = { system: '系统提示', skills: '技能', mcp: 'MCP', tools: '工具', user: '用户消息', assistant: '助手消息', toolResult: '工具结果', other: '其他开销' };
export function ContextCapacity({ value = unknownCapacity(), c, modelLabel, busy, active, compacting, compactionError, onCompact, onCancel }: {
  value?: Capacity; c: Colors; modelLabel: string; busy: boolean; active: boolean; compacting: boolean; compactionError?: string | null; onCompact(): Promise<void>; onCancel(): Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<'compact' | 'cancel' | null>(null);
  const locks = useRef({ compact: false, cancel: false });
  const [failure, setFailure] = useState('');
  const known = value.ratio !== null && Number.isFinite(value.ratio) && value.ratio >= 0;
  const ratio = known ? value.ratio! : 0;
  const over = known && ratio > 1;
  const percentage = !known ? '—' : ratio > 9.99 ? '999%+' : `${ratio > 0 && ratio < .005 ? '<1' : Math.round(ratio * 100)}%`;
  const state = t(value.state === 'current' ? 'Current committed context' : value.state === 'stale' ? 'Last valid snapshot; updating' : value.state === 'pending' ? 'Reading committed context' : 'Capacity unavailable');
  const emphasis = t(value.emphasis === 'over-limit' ? 'Above the model context limit' : value.emphasis === 'blocking' ? 'Above the blocking compaction threshold' : value.emphasis === 'background' ? 'Above the background compaction threshold' : 'Context capacity');
  const color = !known ? c.quiet : over || value.emphasis === 'blocking' ? c.danger : value.emphasis === 'background' ? c.warning : c.accent;
  const circumference = 2 * Math.PI * 7.5;
  async function act(action: () => Promise<void>, kind: 'compact' | 'cancel') {
    if (locks.current[kind]) return;
    locks.current[kind] = true; setWorking(kind); setFailure('');
    try { await action(); } catch (error) { setFailure(String(error).replace(/^Error: /, '').slice(0, 1000)); }
    finally { locks.current[kind] = false; setWorking((current) => current === kind ? null : current); }
  }
  return <>
    <Pressable testID="context-capacity" accessibilityRole="button" accessibilityLabel={t('Context capacity, {value}, view details', { value: percentage })} accessibilityHint={t('Inspect committed context and compaction; excludes drafts')} accessibilityValue={{ text: `${state} · ${emphasis}` }} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={({ pressed }) => [s.button, pressed && { opacity: .55 }]}>
      <Svg width={20} height={20} viewBox="0 0 20 20" accessible={false}>
        <Circle cx={10} cy={10} r={7.5} fill="none" stroke={c.line} strokeWidth={2.5} />
        {known && <Circle cx={10} cy={10} r={7.5} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - Math.min(1, ratio))} rotation={-90} origin="10, 10" />}
      </Svg>
      <Text numberOfLines={1} style={[type.caption, s.value, { color }]}>{percentage}</Text>
    </Pressable>
    <MotionModal value={open ? true : null} onClose={() => setOpen(false)}>{() => (
      <View style={[s.overlay, { backgroundColor: c.scrim }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Close capacity details')} onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <SafeAreaView edges={['bottom']} style={[s.sheet, { backgroundColor: c.surface, borderColor: c.line }]} accessibilityViewIsModal>
          <View style={s.header}><Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t('Context capacity')}</Text><Pressable testID="context-close" accessibilityRole="button" accessibilityLabel={t('Close capacity details')} onPress={() => setOpen(false)} style={({ pressed }) => [s.close, pressed && { opacity: .55 }]}><Icon name="close" color={c.quiet} /></Pressable></View>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <Text selectable style={[type.caption, { color: c.quiet }]}>{modelLabel}</Text>
            <Text testID="context-details-tokens" selectable style={[s.tokens, { color: c.heading }]}>{value.tokens === null ? '—' : '≈' + number(value.tokens)}<Text style={[type.caption, { color: c.quiet }]}>{` / ${number(value.limit)} token`}</Text></Text>
            {!!value.parts?.length && <View style={s.parts}>
              <Text style={[type.label, { color: c.heading }]}>{t('Context composition')}</Text>
              <View style={s.partRow}>
                <Text style={[type.micro, { color: c.faint, width: 64 }]}>{t('Composition')}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[type.micro, { color: c.faint, width: 44, textAlign: 'right' }]}>{t('Token')}</Text>
                <Text style={[type.micro, { color: c.faint, width: 52, textAlign: 'right' }]}>{t('Of window')}</Text>
              </View>
              {[...value.parts].sort((a, b) => b.tokens - a.tokens).map((part) => {
                const share = value.tokens && value.tokens > 0 ? Math.min(1, part.tokens / value.tokens) : 0;
                const percent = value.limit ? part.tokens / value.limit * 100 : 0;
                return <View key={part.key} style={s.partRow}>
                  <Text numberOfLines={1} style={[type.caption, { color: c.quiet, width: 64 }]}>{t(PART_LABEL[part.key] ?? part.key)}</Text>
                  <View style={[s.partTrack, { backgroundColor: c.raised }]}><View style={[s.partFill, { backgroundColor: part.key === 'other' ? c.faint : c.accent, width: `${Math.max(1.5, share * 100)}%` as `${number}%` }]} /></View>
                  <Text selectable style={[type.caption, s.value, { color: c.text, width: 44, textAlign: 'right' }]}>{number(part.tokens)}</Text>
                  <Text style={[type.caption, s.value, { color: c.faint, width: 52, textAlign: 'right' }]}>{percent >= 10 ? `${Math.round(percent)}%` : percent >= 1 ? `${percent.toFixed(1)}%` : percent > 0 ? (percent < .001 ? '<0.001%' : `${percent.toFixed(3)}%`) : '0%'}</Text>
                </View>;
              })}
            </View>}
            {value.state === 'unavailable' && !!value.reason && <Text selectable style={[type.caption, { color: c.quiet }]}>{value.reason}</Text>}
            <View style={[s.policy, { borderColor: c.line }]}>
              {value.emphasis !== 'normal' && <Text style={[type.label, { color: c.heading }]}>{emphasis}</Text>}
              {value.summaryPending && <Text style={[type.caption, { color: c.quiet }]}>{t('Compaction summary ready')}</Text>}
              {compacting && <View style={s.row}><BusyIndicator color={c.accent} /><Text style={[type.caption, { color: c.quiet }]}>{t('Compaction in progress')}</Text></View>}
              {!!compactionError && <Text selectable style={[type.caption, { color: c.danger }]}>{compactionError}</Text>}
              {!!failure && <Text selectable style={[type.caption, { color: c.danger }]}>{t(failure)}</Text>}
              <Pressable testID="context-compact" accessibilityRole="button" accessibilityLabel={t(compacting ? 'Stop compaction' : 'Compact context')} disabled={working === 'cancel' || (!compacting && (!!working || !active || busy || value.summaryPending))} onPress={() => { void act(compacting ? onCancel : onCompact, compacting ? 'cancel' : 'compact'); }} style={({ pressed }) => [s.action, { backgroundColor: c.raised, opacity: working === 'cancel' || (!compacting && (!!working || !active || busy || value.summaryPending)) ? .4 : pressed ? .55 : 1 }]}><Text style={[type.label, { color: c.accent }]}>{t(compacting ? 'Stop compaction' : 'Compact context')}</Text></Pressable>
            </View>
            <Text selectable style={[type.micro, { color: c.quiet }]}>{value.model ? `${value.model.provider}/${value.model.id}\n${t('Configuration revision')} ${value.configurationRevision ?? value.model.revision} · ${t('Context revision')} ${value.revision ?? '—'}` : '—'}</Text>
          </ScrollView>
        </SafeAreaView>
      </View>
    )}</MotionModal>
  </>;
}
const s = StyleSheet.create({
  button: { minHeight: 44, minWidth: 58, paddingHorizontal: 6, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 0 },
  value: { fontVariant: ['tabular-nums'] },
  overlay: { flex: 1, justifyContent: 'flex-end' }, sheet: { maxHeight: '82%', borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 24, paddingRight: 12, minHeight: 64 }, close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 24, paddingTop: 2, gap: 16 }, parts: { gap: 10 }, partRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, partTrack: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' }, partFill: { height: '100%', borderRadius: 3 }, tokens: { fontSize: 24, lineHeight: 34, fontVariant: ['tabular-nums'] }, policy: { paddingTop: 16, gap: 12 }, action: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, paddingHorizontal: 16 }, row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
