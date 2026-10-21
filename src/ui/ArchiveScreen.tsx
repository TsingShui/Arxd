import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n';
import { getAndroidWorkspace } from '../workspace/android';
import type { SearchGroup, Workspace, WorkspaceSnapshot } from '../workspace/core';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { layout } from './theme';
import { type } from './type';

/** Archived history is read without implicitly restoring it. */
export default function ArchiveScreen() {
  const { t } = useI18n(); const { c } = useTheme();
  const [core, setCore] = useState<Workspace>(); const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [query, setQuery] = useState(''); const [result, setResult] = useState<{ query: string; groups: SearchGroup[] }>({ query: '', groups: [] });
  const [working, setWorking] = useState<number>(); const [error, setError] = useState('');
  const needle = query.trim();
  const index = snapshot?.conversations.filter((row) => row.archived).map((row) => `${row.id}/${row.updatedAt}`).join(',');
  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((workspace) => { if (active) { setCore(workspace); setSnapshot(workspace.getSnapshot()); unsubscribe = workspace.subscribe(setSnapshot); } }).catch((error) => { if (active) setError(String(error)); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    if (!core || !needle) return;
    let active = true;
    const timer = setTimeout(() => { void core.search(needle, null, 'archived').then((groups) => { if (active) { setResult({ query: needle, groups }); setError(''); } }).catch((error) => { if (active) { setError(String(error)); setResult({ query: needle, groups: [] }); } }); }, 220);
    return () => { active = false; clearTimeout(timer); };
  }, [core, needle, index]);
  const all = snapshot?.conversations.filter((row) => row.archived) ?? [];
  const searching = !!needle && result.query !== needle;
  const shown = needle ? result.query === needle ? all.filter((row) => result.groups.some((group) => group.id === row.id)) : [] : all;
  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => router.back()} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable><Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t('Archive')}</Text><Text style={[type.caption, { color: c.quiet }]}>{all.length}</Text></View>
    <View style={s.searchRow}>
      <Icon name="search" color={c.quiet} size={18} />
      <TextInput accessibilityLabel={t('Search archived conversations')} testID="archive-search" value={query} onChangeText={setQuery} maxLength={1024} placeholder={t('Search archived titles, messages and files')} placeholderTextColor={c.faint} style={[s.search, { color: c.text }]} />
    </View>
    {!!error && <Text selectable style={[s.note, { color: c.danger }]}>{t(error)}</Text>}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.body, !shown.length && s.emptyBody]}>
      {searching ? <BusyIndicator color={c.accent} /> : !shown.length ? <Text style={[s.empty, { color: c.quiet }]}>{t(needle ? 'No matching archived conversations' : 'No archived conversations yet')}</Text> : shown.map((row) => <View key={row.id} style={s.item}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Open archived conversation {title}', { title: row.title })} testID={`archive-open-${row.id}`} onPress={() => { void core?.select(row.id).then(() => router.navigate('/')).catch((error) => setError(String(error))); }} style={({ pressed }) => [s.open, pressed && { backgroundColor: c.wash }]}>
          <View style={s.itemText}>
            <Text numberOfLines={2} style={[type.body, { color: c.heading }]}>{row.title}</Text>
            <Text style={[type.micro, { color: c.quiet }]}>{new Date(row.updatedAt).toLocaleString()}</Text>
            {!!needle && <Text numberOfLines={2} style={[type.caption, { color: c.quiet }]}>{result.groups.find((group) => group.id === row.id)?.hits[0]?.text}</Text>}
          </View>
          {row.busy && <BusyIndicator color={c.accent} />}
        </Pressable>
        <View style={s.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Restore conversation {title}', { title: row.title })} testID={`archive-restore-${row.id}`} disabled={working !== undefined} onPress={() => { setWorking(row.id); void core?.archive(row.id, false).catch((error) => setError(String(error))).finally(() => setWorking(undefined)); }} style={({ pressed }) => [s.action, pressed && { opacity: .55 }, working !== undefined && { opacity: .4 }]}><Text style={[type.label, { color: c.accent }]}>{t('Restore')}</Text>{working === row.id && <BusyIndicator color={c.accent} />}</Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Delete archived conversation {title}', { title: row.title })} testID={`archive-delete-${row.id}`} disabled={working !== undefined} onPress={() => Alert.alert(t('Delete this conversation?'), t('Conversation history will be permanently deleted. Attachments and saved files stay in the file library. Running tasks will stop first.'), [{ text: t('Cancel'), style: 'cancel' }, { text: t('Delete conversation (2)'), style: 'destructive', onPress: () => { setWorking(row.id); void core?.purge(row.id).catch((error) => setError(String(error))).finally(() => setWorking(undefined)); } }])} style={({ pressed }) => [s.action, pressed && { opacity: .55 }, working !== undefined && { opacity: .4 }]}><Text style={[type.label, { color: c.danger }]}>{t('Delete')}</Text></Pressable>
        </View>
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { minHeight: layout.header, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  back: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 20, minHeight: 44 },
  search: { ...type.body, flex: 1, paddingVertical: 8 },
  note: { ...type.caption, marginHorizontal: 20, marginVertical: 10 },
  body: { paddingBottom: 36 }, emptyBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { ...type.caption, paddingHorizontal: 20 },
  item: { paddingVertical: 4 }, itemText: { flex: 1, gap: 4 },
  open: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 20, paddingVertical: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 20, paddingBottom: 10 },
  action: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
