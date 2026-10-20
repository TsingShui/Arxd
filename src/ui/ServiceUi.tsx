import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n/index.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace } from '../workspace/core';
import type { ProcessRecord } from '../workspace/service-types';
import { Icon } from './Icon';
import { type Colors } from './theme';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { type } from './type';

export function useServiceWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>();
  const { c, palette } = useTheme();
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    void getAndroidWorkspace().then((core) => {
      if (!alive.current) return;
      setWorkspace(core);
      if (!core.services) setError('当前宿主不支持服务管理');
    }).catch((failure) => { if (alive.current) setError(String(failure).slice(0, 1000)); });
    return () => { alive.current = false; };
  }, []);
  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setWorking(true); setError('');
    try { await action(); } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  return { workspace, services: workspace?.services, c, palette, error, setError, working, perform, alive };
}

export function ServiceFrame({ title, c, working, error, back, right, headerBusy = true, children }: { title: string; c: Colors; palette: string; working: boolean; error: string; back?: () => void; right?: ReactNode; headerBusy?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return <KeyboardAvoidingView behavior="height" style={ui.screen}><SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}><View style={ui.header}><Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={back ?? (() => router.back())} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable><Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{t(title)}</Text>{right}{headerBusy && working && <BusyIndicator color={c.accent} />}</View>{!!error && <Text selectable accessibilityRole="alert" style={[ui.error, { color: c.danger }]}>{t(error)}</Text>}{children}</SafeAreaView></KeyboardAvoidingView>;
}

export const processLabel: Record<ProcessRecord['state'], string> = { queued: '等待启动', starting: '正在启动', running: '运行中', stopping: '正在停止', exited: '已退出', failed: '启动或运行失败', lost: '控制权未知' };

export const ui = StyleSheet.create({
  screen: { flex: 1 }, header: { height: 64, paddingHorizontal: 12, flexDirection: 'row', gap: 12, alignItems: 'center' },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 20, paddingBottom: 48, gap: 10 },
  error: { ...type.caption, marginHorizontal: 20, marginVertical: 8 },
});
