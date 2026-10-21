import { useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Rxd, { type InstalledApp } from '../../modules/rxd';
import { useI18n } from '../i18n';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import { MAX_IMPORT_BYTES } from '../workspace/limits';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { type } from './type';

const sizeLabel = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export default function InstalledAppsScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [query, setQuery] = useState('');
  const [includeSystem, setIncludeSystem] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<InstalledApp>();
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const paging = useRef(false);
  const importing = useRef(false);
  const busy = working || !!snapshot?.busy;

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((core) => {
      if (!alive.current) return;
      setWorkspace(core); setSnapshot(core.getSnapshot()); unsubscribe = core.subscribe(setSnapshot);
    }).catch((failure) => { if (alive.current) setError(String(failure).replace(/^Error: /, '')); });
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    paging.current = false;
    // Reset happens in the debounced callback, not synchronously in the effect.
    const timer = setTimeout(() => {
      setLoading(true); setApps([]); setSelected(undefined); setNextOffset(null);
      void Rxd.listInstalledApps(query.trim(), 0, includeSystem).then((page) => {
        if (!disposed && alive.current) { setApps(page.apps); setNextOffset(page.nextOffset); }
      }).catch((failure) => {
        if (!disposed && alive.current) setError(String(failure).replace(/^Error: /, ''));
      }).finally(() => { if (!disposed && alive.current) setLoading(false); });
    }, 180);
    return () => { disposed = true; clearTimeout(timer); };
  }, [query, includeSystem, revision]);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 7000);
    return () => clearTimeout(timer);
  }, [error]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (importing.current) return true;
      if (selected) { setSelected(undefined); return true; }
      return false;
    });
    return () => listener.remove();
  }, [selected]);

  async function more() {
    if (nextOffset === null || loading || paging.current) return;
    paging.current = true;
    try {
      const page = await Rxd.listInstalledApps(query.trim(), nextOffset, includeSystem);
      if (alive.current) {
        setApps((old) => [...old, ...page.apps.filter((app) => !old.some((entry) => entry.packageName === app.packageName))]);
        setNextOffset(page.nextOffset);
      }
    } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '')); }
    finally { paging.current = false; }
  }
  async function importApp() {
    if (!workspace || !selected || busy || importing.current) return;
    importing.current = true; setWorking(true); setError('');
    try {
      const result = await Rxd.importInstalledApp(selected.packageName, selected.revision, snapshot?.importLimit ?? MAX_IMPORT_BYTES);
      const file = await workspace.attachInstalledApp(result);
      if (alive.current) router.dismissTo({ pathname: '/', params: { attachmentId: file.id, composeId: globalThis.crypto.randomUUID() } });
    } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '')); }
    finally { importing.current = false; if (alive.current) setWorking(false); }
  }
  function back() { if (!working) { if (selected) setSelected(undefined); else router.back(); } }

  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} disabled={working} onPress={back} style={s.icon}><Icon name="back" color={working ? c.faint : c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{t('Installed apps')}</Text>
      {working ? <BusyIndicator color={c.accent} /> : <Pressable accessibilityRole="button" accessibilityLabel={t('Refresh')} onPress={() => setRevision((value) => value + 1)} style={s.icon}><Icon name="refresh" color={c.quiet} size={20} /></Pressable>}
    </View>
    {selected ? <View style={s.details}>
      <Text numberOfLines={2} style={[type.heading, { color: c.heading }]}>{selected.label}</Text>
      <Text selectable style={[type.caption, { color: c.quiet }]}>{selected.packageName}</Text>
      <Text style={[type.caption, { color: c.quiet }]}>{selected.versionName || selected.versionCode} · {sizeLabel(selected.bytes)}</Text>
      <Text style={[type.body, { color: c.text }]}>{t('Base APK + {count} split APKs', { count: selected.apkCount - 1 })}</Text>
      <Pressable testID="import-installed-app" accessibilityRole="button" accessibilityLabel={t('Import APKs')} disabled={!workspace || busy} onPress={() => { void importApp(); }} style={({ pressed }) => [s.import, pressed && { opacity: .55 }, (!workspace || busy) && { opacity: .4 }]}>
        <Icon name="download" color={c.accent} size={20} /><Text style={[type.list, { color: c.accent }]}>{t(working ? 'Importing APKs' : 'Import APKs')}</Text>
      </Pressable>
    </View> : <>
      <View style={s.controls}>
        <View style={[s.search, { backgroundColor: c.wash }]}><Icon name="search" color={c.faint} size={18} /><TextInput testID="installed-app-search" accessibilityLabel={t('Search installed apps')} placeholder={t('Search installed apps')} placeholderTextColor={c.faint} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} maxLength={200} style={[type.body, { color: c.text, flex: 1, paddingVertical: 8 }]} /></View>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: includeSystem }} accessibilityLabel={t('System apps')} onPress={() => setIncludeSystem((value) => !value)} style={s.filter}><Icon name={includeSystem ? 'check' : 'plus'} color={includeSystem ? c.accent : c.quiet} size={16} /><Text numberOfLines={1} style={[type.caption, { color: includeSystem ? c.accent : c.quiet }]}>{t('System apps')}</Text></Pressable>
      </View>
      <FlatList data={apps} keyExtractor={(app) => app.packageName} keyboardShouldPersistTaps="handled" contentContainerStyle={s.list} onEndReached={() => { void more(); }} onEndReachedThreshold={.5}
        ListEmptyComponent={loading ? <View style={s.empty}><BusyIndicator color={c.quiet} /></View> : <Text style={[type.caption, s.empty, { color: c.quiet }]}>{t('No installed apps found')}</Text>}
        renderItem={({ item }) => <Pressable testID={`installed-app-${item.packageName}`} accessibilityRole="button" accessibilityLabel={t('Select app {name}', { name: item.label })} disabled={busy} onPress={() => setSelected(item)} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
          <Icon name="grid" color={c.quiet} size={22} /><View style={{ flex: 1, gap: 3 }}><Text numberOfLines={1} style={[type.list, { color: c.text }]}>{item.label}</Text><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{item.packageName}</Text><Text style={[type.caption, { color: c.faint }]}>{t('{count} APKs', { count: item.apkCount })} · {sizeLabel(item.bytes)}</Text></View><Icon name="right" color={c.faint} size={16} />
        </Pressable>} />
    </>}
    {!!error && <View accessibilityLiveRegion="polite" style={[s.toast, { backgroundColor: c.surface }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger }]}>{t(error)}</Text></View>}
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { minHeight: 62, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { padding: 10 }, controls: { paddingHorizontal: 24, gap: 10, paddingBottom: 10 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 12 },
  filter: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingVertical: 8 },
  list: { paddingBottom: 24 }, row: { paddingHorizontal: 26, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  details: { padding: 28, gap: 16 }, import: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 10, paddingVertical: 14, marginTop: 8 },
  empty: { padding: 28 }, toast: { position: 'absolute', left: 24, right: 24, bottom: 28, padding: 16, borderRadius: 12 },
});
