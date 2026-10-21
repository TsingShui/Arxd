import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useI18n } from '../i18n';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace } from '../workspace/core';
import { fetchMarketSkill, searchMarket, type MarketSearchItem, type MarketSkill } from '../workspace/market';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { type } from './type';

const installs = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value);
const size = (bytes: number) => bytes >= 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${bytes} B`;

export default function SkillMarketScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketSearchItem[]>([]);
  const [selected, setSelected] = useState<MarketSearchItem>();
  const [detail, setDetail] = useState<MarketSkill>();
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const installToken = useRef<string | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    void getAndroidWorkspace().then((core) => { if (alive.current) setWorkspace(core); });
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 7000);
    return () => clearTimeout(timer);
  }, [error]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (working) return true;
      if (selected) { setSelected(undefined); setDetail(undefined); return true; }
      return false;
    });
    return () => listener.remove();
  }, [selected, working]);

  const run = useCallback(async (value: string) => {
    abort.current?.abort();
    const token = new AbortController();
    abort.current = token;
    setLoading(true); setError('');
    try {
      const found = await searchMarket(value, token.signal);
      if (alive.current && !token.signal.aborted) { setItems(found); setSearched(true); }
    } catch (failure) {
      if (alive.current && !token.signal.aborted) setError(String(failure).replace(/^Error: /, ''));
    } finally { if (alive.current && !token.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    // Short queries reset in the debounced callback so the effect never sets state.
    const timer = setTimeout(() => {
      if (query.trim().length < 2) { abort.current?.abort(); setItems([]); setSearched(false); setLoading(false); return; }
      void run(query);
    }, 450);
    return () => clearTimeout(timer);
  }, [query, run]);

  async function open(item: MarketSearchItem) {
    setSelected(item); setDetail(undefined); setError('');
    setWorking(true);
    const token = new AbortController();
    abort.current?.abort(); abort.current = token;
    try {
      const skill = await fetchMarketSkill(item.id, token.signal);
      if (alive.current && !token.signal.aborted) setDetail(skill);
    } catch (failure) { if (alive.current && !token.signal.aborted) setError(String(failure).replace(/^Error: /, '')); }
    finally { if (alive.current) setWorking(false); }
  }
  async function install() {
    if (!workspace || !selected || !detail || working) return;
    const token = `${detail.id}`;
    installToken.current = token;
    setWorking(true); setError('');
    try {
      const record = await workspace.skills.importMarket(detail);
      if (alive.current && installToken.current === token) {
        setNotice(t('Installed {name}. Enable it in Skills.', { name: record.name }));
        setSelected(undefined); setDetail(undefined);
      }
    } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '')); }
    finally { if (alive.current) setWorking(false); }
  }
  function back() {
    if (working) return;
    if (selected) { setSelected(undefined); setDetail(undefined); return; }
    router.back();
  }

  const total = detail ? detail.files.reduce((sum, file) => sum + new TextEncoder().encode(file.contents).length, 0) : 0;
  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} disabled={working} onPress={back} style={s.icon}><Icon name="back" color={working ? c.faint : c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{selected?.name ?? t('Skill market')}</Text>
      {working ? <BusyIndicator color={c.accent} /> : !selected && <Pressable accessibilityRole="button" accessibilityLabel={t('Refresh')} testID="market-refresh" onPress={() => { if (query.trim().length >= 2) void run(query.trim()); }} style={s.icon}><Icon name="refresh" color={c.quiet} size={20} /></Pressable>}
    </View>

    {selected ? <ScrollView contentContainerStyle={s.detail}>
      <Text numberOfLines={3} style={[type.heading, { color: c.heading }]}>{selected.name}</Text>
      <Text selectable style={[type.caption, { color: c.quiet }]}>{selected.source}</Text>
      <Text style={[type.caption, { color: c.faint }]}>{t('{count} installs', { count: installs(selected.installs) })}</Text>
      {detail ? <>
        <Text style={[type.caption, { color: c.heading, marginTop: 10 }]}>{t('Skill files')} · {detail.files.length} · {size(total)}</Text>
        {detail.files.map((file) => <View key={file.path} style={[s.file, { borderBottomColor: c.line }]}><Icon name="file" color={c.faint} size={17} /><Text numberOfLines={1} style={[type.caption, { color: c.text, flex: 1 }]}>{file.path}</Text><Text style={[type.caption, { color: c.faint }]}>{size(new TextEncoder().encode(file.contents).length)}</Text></View>)}
        {detail.marketHash && <Text selectable style={[type.caption, { color: c.faint, marginTop: 8 }]}>{t('Registry hash')} {detail.marketHash.slice(0, 16)}</Text>}
        <Pressable testID="market-install" accessibilityRole="button" accessibilityLabel={t('Install skill')} disabled={!workspace || working} onPress={() => { void install(); }} style={({ pressed }) => [s.install, pressed && { opacity: .55 }, (!workspace || working) && { opacity: .4 }]}>
          <Icon name="download" color={c.accent} size={20} /><Text style={[type.list, { color: c.accent }]}>{t(working ? 'Installing' : 'Install skill')}</Text>
        </Pressable>
      </> : <Text style={[type.caption, { color: c.quiet, marginTop: 10 }]}>{t('Reading the skill files')}</Text>}
    </ScrollView> : <>
      <View style={[s.search, { backgroundColor: c.wash }]}>
        <Icon name="search" color={c.faint} size={18} />
        <TextInput testID="market-search" accessibilityLabel={t('Search skills.sh')} placeholder={t('Search skills.sh')} placeholderTextColor={c.faint}
          value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} maxLength={200} style={[type.body, { color: c.text, flex: 1, paddingVertical: 8 }]} />
        {loading && <BusyIndicator color={c.quiet} size="small" />}
      </View>
      <FlatList data={items} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" contentContainerStyle={s.list}
        ListHeaderComponent={<Text style={[type.caption, { color: c.faint, paddingHorizontal: 26, paddingBottom: 8 }]}>{t('Public catalog from skills.sh. Installing downloads the skill as data.')}</Text>}
        ListEmptyComponent={loading ? undefined : <Text style={[type.caption, { color: c.quiet, paddingHorizontal: 26, paddingTop: 12 }]}>{t(searched ? 'No skills found' : 'Search the public skill catalog')}</Text>}
        renderItem={({ item }) => <Pressable testID={`market-${item.id}`} accessibilityRole="button" accessibilityLabel={t('Open {name}', { name: item.name })} disabled={working}
          onPress={() => { void open(item); }} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
          <View style={{ flex: 1, gap: 3 }}><Text numberOfLines={1} style={[type.list, { color: c.text }]}>{item.name}</Text>
            <Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{item.source}</Text>
            <Text style={[type.caption, { color: c.faint }]}>{t('{count} installs', { count: installs(item.installs) })}</Text></View>
          <Icon name="right" color={c.faint} size={16} />
        </Pressable>} />
    </>}
    {!!notice && <View pointerEvents="none" accessibilityLiveRegion="polite" style={[s.toast, { backgroundColor: c.surface, borderColor: c.accentLine }]}><Text style={[type.caption, { color: c.heading }]}>{notice}</Text></View>}
    {!!error && <View accessibilityLiveRegion="polite" style={[s.toast, { backgroundColor: c.surface, borderColor: c.danger }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger }]}>{t(error)}</Text></View>}
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { minHeight: 62, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { padding: 10 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 24, paddingHorizontal: 12, borderRadius: 12, marginBottom: 10 },
  list: { paddingBottom: 24 }, row: { paddingHorizontal: 26, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  detail: { paddingHorizontal: 26, paddingBottom: 32, gap: 6 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  install: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 10, paddingVertical: 14, marginTop: 12 },
  toast: { position: 'absolute', left: 24, right: 24, bottom: 28, padding: 14, borderRadius: 12, borderWidth: 1 },
});
