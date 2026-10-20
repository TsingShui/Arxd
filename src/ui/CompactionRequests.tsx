import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useI18n } from '../i18n';
import type { RequestRecord } from '../workspace/request-records';
import type { Colors } from './theme';
import { type } from './type';

/** Separate summarization diagnostics: never labels a completed answer failed. */
export function CompactionRequests({ records, pending, c }: { records: RequestRecord[]; pending: { attempt: number; retryAt?: number }[]; c: Colors }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const retry = pending.find((item) => item.retryAt !== undefined);
  useEffect(() => {
    if (!retry) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retry]);
  if (!records.length && !retry) return null;
  return <View style={{ paddingHorizontal: 20, paddingVertical: 8, borderBottomColor: c.line, borderBottomWidth: 1 }}>
    {retry && <Text accessibilityLiveRegion="polite" style={[type.caption, { color: c.accent }]}>{t('Context compaction')} · {t('Network retry {attempt}/3 · next attempt in {seconds}s', { attempt: retry.attempt, seconds: Math.max(0, Math.ceil((retry.retryAt! - now) / 1000)) })}</Text>}
    {!!records.length && <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={[type.caption, { color: c.quiet }]}>{t('Compaction requests · {count}', { count: records.length })} {open ? '⌃' : '⌄'}</Text></Pressable>}
    {open && records.slice(-16).map((record) => <View key={`${record.requestId}/${record.attempt}`} style={{ paddingBottom: 12 }}><Text style={[type.caption, { color: record.failure ? c.danger : c.quiet }]}>{t('Request {attempt}/4 · {category}', { attempt: record.attempt, category: record.failure?.category ?? t('Done (2)') })}</Text>{record.failure && <Text selectable style={[type.caption, { color: c.danger }]}>{record.failure.message}</Text>}{!!record.partial && <Text selectable style={[type.micro, { color: c.quiet }]}>{record.partial.slice(0, 1000)}</Text>}</View>)}
    {open && records.length > 16 && <Text style={[type.micro, { color: c.quiet }]}>{t('Showing the latest 16 request records')}</Text>}
  </View>;
}
