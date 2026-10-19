import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n/index.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { useTheme } from './appearance';
import { type } from './type';

/** Conversation-title search. Message and file content are intentionally out of scope. */
export default function SearchScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const needle = query.trim().toLowerCase();
  const conversations = (snapshot?.conversations ?? []).filter((row) => !needle || row.title.toLowerCase().includes(needle));

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((core) => {
      if (!live) return;
      setWorkspace(core); setSnapshot(core.getSnapshot()); unsubscribe = core.subscribe(setSnapshot);
    }).catch((failure) => { if (live) setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); });
    return () => { live = false; unsubscribe?.(); };
  }, []);

  async function open(id: WorkspaceSnapshot['active']) {
    if (id === null) return;
    try { await workspace?.select(id); router.back(); }
    catch (failure) { setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); }
  }

  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('返回')} onPress={() => router.back()} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
      <Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t('搜索会话')}</Text>
    </View>
    <View style={[s.field, { backgroundColor: c.raised }]}><Icon name="search" color={c.faint} size={17} /><TextInput testID="search-input" accessibilityLabel={t('搜索会话')} value={query} onChangeText={setQuery} maxLength={1024} placeholder={t('搜索会话标题')} placeholderTextColor={c.faint} style={[type.body, { color: c.text, flex: 1, paddingVertical: 0 }]} /></View>
    {!!error && <Text style={[type.caption, { color: c.danger, paddingHorizontal: 20 }]}>{error}</Text>}
    <FlatList
      data={conversations}
      keyExtractor={(row) => String(row.id)}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[s.body, !conversations.length && s.emptyBody]}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={5}
      removeClippedSubviews
      ListEmptyComponent={<Text style={[type.caption, { color: c.faint, textAlign: 'center' }]}>{t(query.trim() ? '没有匹配的会话' : '还没有会话')}</Text>}
      renderItem={({ item: row }) => <Pressable accessibilityRole="button" accessibilityLabel={t('打开对话 {title}', { title: row.title })} onPress={() => { void open(row.id); }} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}><Icon name="chat" color={c.quiet} size={19} /><Text numberOfLines={2} style={[type.list, { color: c.text, flex: 1 }]}>{row.title}</Text>{row.archived && <Text style={[type.micro, { color: c.quiet }]}>{t('已归档')}</Text>}</Pressable>}
    />
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  field: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, marginHorizontal: 20, marginBottom: 6 },
  body: { paddingHorizontal: 20, paddingBottom: 32 },
  emptyBody: { flexGrow: 1, justifyContent: 'center' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: -20, paddingHorizontal: 20 },
});
