import { useTheme } from './appearance';
import { router, useFocusEffect } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SkillWorking } from '../../modules/rxd';
import { useI18n } from '../i18n/index.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import type { SkillRecord } from '../workspace/skills';
import { CodeBlock } from './CodeText';
import { CodeEditor } from './CodeEditor';
import { Icon, type IconName } from './Icon';
import { ui } from './ServiceUi';
import { type Colors } from './theme';
import { type } from './type';

function SkillRow({ icon, title, action, disabled, c, danger = false }: { icon: IconName; title: string; action: () => void; disabled?: boolean; c: Colors; danger?: boolean }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(title)} disabled={disabled} onPress={action} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }, disabled && { opacity: .35 }]}><Icon name={icon} color={danger ? c.danger : c.quiet} size={18} /><Text style={[type.list, { color: danger ? c.danger : c.text }]}>{t(title)}</Text></Pressable>;
}

export default function SkillsScreen() {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [records, setRecords] = useState<SkillRecord[]>([]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<SkillRecord>();
  const [definition, setDefinition] = useState<SkillWorking>();
  const [editor, setEditor] = useState(false);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const locked = useRef(false);
  const request = useRef(0);
  const { c } = useTheme();
  const busy = snapshot?.conversations.some((conversation) => conversation.busy) ?? false;
  const chosen = snapshot?.selectedSkills.some((skill) => skill.id === selected?.id) ?? false;
  const selectedId = selected?.id;

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((core) => {
      if (!alive.current) return;
      setWorkspace(core); setSnapshot(core.getSnapshot()); unsubscribe = core.subscribe(setSnapshot);
    }).catch((failure) => { if (alive.current) { setError(String(failure)); setLoading(false); } });
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);

  useFocusEffect(useCallback(() => {
    if (!workspace) return;
    let active = true;
    async function update() {
      try {
        const rows = await workspace!.skills.list();
        if (!active) return;
        setRecords(rows); setLoading(false);
        const scan = workspace!.skills.scanStatus();
        if (scan?.error || scan?.aliasError) setError(scan.error || scan.aliasError || '');
        const row = rows.find((row) => row.id === selectedId);
        if (row) {
          setSelected(row);
          if (!editor && row.status === 'active') {
            const body = await workspace!.skills.working(row.id);
            if (active) { setDefinition(body); setText(body.definition); }
          }
        }
      } catch (failure) { if (active) { setError(String(failure)); setLoading(false); } }
    }
    const unsubscribe = workspace.skills.subscribe(() => { void update(); });
    void workspace.skills.refresh().then(update).catch((failure) => { if (active) { setError(String(failure)); setLoading(false); } });
    return () => { active = false; unsubscribe(); };
  }, [workspace, selectedId, editor]));

  function back() {
    if (searchOpen) { setSearchOpen(false); setQuery(''); return; }
    if (editor && text !== definition?.definition) {
      Alert.alert(t('Discard unsaved changes?'), '', [{ text: t('Cancel') }, { text: t('Discard changes'), style: 'destructive', onPress: () => { setEditor(false); setText(definition?.definition ?? ''); } }]); return;
    }
    if (selected) { request.current++; setSelected(undefined); setDefinition(undefined); setEditor(false); setError(''); }
    else router.back();
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { if (searchOpen) { setSearchOpen(false); setQuery(''); return true; } if (selected) { back(); return true; } return false; });
    return () => listener.remove();
  });

  async function perform(action: () => Promise<void>) {
    if (locked.current || !workspace) return;
    locked.current = true; setWorking(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); }
    finally {
      locked.current = false;
      if (alive.current) { setRecords(await workspace.skills.list()); setWorking(false); }
    }
  }
  async function open(record: SkillRecord) {
    const token = ++request.current;
    setSelected(record); setDefinition(undefined); setEditor(false);
    await perform(async () => {
      const current = await workspace!.skills.working(record.id);
      if (alive.current && request.current === token) { setDefinition(current); setText(current.definition); }
    });
  }
  async function importFile() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return;
    const asset = result.assets[0];
    const archive = /\.zip$/i.test(asset.name) || /zip/i.test(asset.mimeType ?? '');
    await perform(async () => { const row = await workspace!.skills.import(archive ? 'archive' : 'file', asset.uri); setSelected(row); const body = await workspace!.skills.working(row.id); setDefinition(body); setText(body.definition); setNotice(t('Skill imported and disabled by default')); });
  }
  async function save() {
    if (!selected || !definition) return;
    await perform(async () => { const row = await workspace!.skills.save(selected.id, text, definition.sha256); setSelected(row); setDefinition(await workspace!.skills.working(row.id)); setEditor(false); setNotice(t('Skill updated')); });
  }
  function remove() {
    if (!selected) return;
    Alert.alert(t('Delete skill {name}?', { name: selected.name }), t('The skill directory and resources will be deleted. Conversation messages and existing tool records are kept.'), [{ text: t('Cancel') }, { text: t('Delete'), style: 'destructive', onPress: () => { void perform(async () => { await workspace!.skills.remove(selected.id); setSelected(undefined); setDefinition(undefined); }); } }]);
  }
  const filtered = records.filter((row) => `${row.name}\n${row.description}`.toLowerCase().includes(query.toLowerCase()));
  return <KeyboardAvoidingView behavior="height" style={s.screen}><SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={back} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{selected?.name ?? t('Skills')}</Text>
      {searchOpen ? <Pressable accessibilityRole="button" accessibilityLabel={t('Close search')} testID="skill-search-close" onPress={() => { setSearchOpen(false); setQuery(''); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="close" color={c.text} size={19} /></Pressable> : editor ? <Pressable accessibilityRole="button" accessibilityLabel={t('Save skill')} disabled={working || busy} onPress={() => { void save(); }} style={({ pressed }) => [s.headerAction, pressed && { opacity: .55 }, (working || busy) && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t('Save skill')}</Text></Pressable> : <View style={s.headerActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Skill market')} testID="skill-market" disabled={working || busy} onPress={() => router.push('/skill-market')} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || busy) && { opacity: .35 }]}><Icon name="grid" color={c.text} size={19} /></Pressable>
        <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('Import skill')} testID="skill-import-file" disabled={working || busy || !workspace} onPress={() => { void importFile(); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || busy || !workspace) && { opacity: .35 }]}><Icon name="upload" color={c.text} size={19} /></Pressable>
        <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('Refresh skills')} testID="skill-refresh" disabled={working || !workspace} onPress={() => { void perform(async () => { setRecords(await workspace!.skills.refresh()); }); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || !workspace) && { opacity: .35 }]}><Icon name="refresh" color={c.text} size={19} /></Pressable>
        <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('Search skills')} testID="skill-search" onPress={() => { setQuery(''); setSearchOpen(true); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="search" color={c.text} size={19} /></Pressable>
      </View>}
    </View>
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={!selected && !loading && !filtered.length ? [ui.body, s.emptyBody] : ui.body} keyboardShouldPersistTaps="handled">
      {!!error && <Text selectable style={[type.caption, { color: c.danger }]}>{t(error)}</Text>}
      {!!notice && <Text style={[type.caption, { color: c.accent }]}>{t(notice)}</Text>}
      {!selected ? <>
        {loading && <Text style={[type.caption, { color: c.quiet }]}>{t('Loading')}</Text>}
        {!loading && !filtered.length && <View style={s.emptyState}>
          <Text style={[type.heading, { color: c.heading, textAlign: 'center' }]}>{t('No skills installed')}</Text>
          <Text style={[type.caption, { color: c.quiet, textAlign: 'center', maxWidth: 300 }]}>{t('Use the file icon in the top right to import a SKILL.md or .zip.')}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Ask the agent to install a skill')} testID="skill-empty-ask" onPress={() => router.navigate({ pathname: '/', params: { prompt: t('I want to install a skill. Ask me what capability I need, then inspect the environment and help me install and verify it.'), composeId: globalThis.crypto.randomUUID() } })} style={({ pressed }) => [s.emptyAsk, pressed && { opacity: .55 }]}><Icon name="chat" color={c.accent} size={18} /><Text style={[type.label, { color: c.accent }]}>{t('Ask the agent to install a skill')}</Text></Pressable>
        </View>}
        {filtered.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={t('View skill {name}', { name: row.name })} disabled={working} onPress={() => { void open(row); }} style={({ pressed }) => [s.skillRow, pressed && { backgroundColor: c.wash }, working && { opacity: .35 }]}><Icon name="spark" color={row.enabled && row.status === 'active' ? c.accent : c.quiet} size={20} /><View style={s.rowMeta}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{row.description}</Text><Text style={[type.micro, { color: row.error ? c.danger : c.quiet }]}>{t(row.status === 'deleting' ? 'Deletion needs retry' : row.status === 'removed' ? 'Source directory removed' : row.status !== 'active' ? 'Skill unavailable' : row.enabled ? 'Enabled' : 'Disabled')}</Text></View></Pressable>)}
      </> : <>
        <Text style={[type.body, { color: c.text }]}>{selected.description}</Text>
        {!!selected.compatibility && <Text style={[type.caption, { color: c.quiet }]}>{selected.compatibility}</Text>}
        {!!selected.license && <Text style={[type.caption, { color: c.quiet }]}>{t('License: {license}', { license: selected.license })}</Text>}
        {!!selected.allowedTools && <Text style={[type.caption, { color: c.quiet }]}>{t('Declared tools (no additional permissions): {tools}', { tools: selected.allowedTools })}</Text>}
        <Text selectable style={[type.micro, { color: c.quiet }]}>{t('Source: {source}', { source: selected.source === 'file' ? t('Definition file') : selected.source === 'archive' ? t('Archive') : selected.source === 'tree' ? t('Device folder') : selected.source === 'shell' ? 'Shell' : t('Workspace') })}{' · '}{t('Version: {version}', { version: selected.version.slice(0, 12) })}{'\n'}{selected.path}</Text>
        {!!selected.error && <Text style={[type.caption, { color: c.danger }]}>{t(selected.error)}</Text>}
        <SkillRow icon="check" title={selected.enabled ? '停用技能' : '启用技能'} disabled={working || busy || (selected.status === 'deleting' || selected.status === 'removed')} c={c} action={() => { void perform(async () => { setSelected(await workspace!.skills.enabled(selected.id, !selected.enabled)); }); }} />
        <SkillRow icon="chat" title={chosen ? '取消会话选择' : '用于当前会话'} disabled={working || busy || (!chosen && (!selected.enabled || selected.status !== 'active'))} c={c} action={() => { void perform(async () => { await workspace!.skills.choose(selected.id, !chosen); if (!chosen) router.navigate('/'); }); }} />
        <SkillRow icon="edit" title="Edit skill instructions" disabled={working || busy || !definition || selected.status === 'deleting'} c={c} action={() => setEditor(true)} />
        <SkillRow icon="folder" title="Manage scripts and resources" disabled={working || selected.status === 'deleting'} c={c} action={() => router.push({ pathname: '/files', params: { root: 'skills', path: selected.path } })} />
        <SkillRow icon="trash" title="Delete skill" danger disabled={working || busy} c={c} action={remove} />
        {editor ? <CodeEditor text={text} language="markdown" c={c} editable={!working} maxLength={65536} label={t('Skill instructions')} onChangeText={setText} style={s.editorShell} /> : <View style={[s.definition, { backgroundColor: c.code }]}><CodeBlock code={definition?.definition ?? t('Skill instructions unavailable')} language="markdown" c={c} /></View>}
      </>}
    </ScrollView>
    {searchOpen && <View style={[StyleSheet.absoluteFill, { backgroundColor: c.background }]}><ScrollView contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled"><TextInput autoFocus accessibilityLabel={t('Search skills')} value={query} onChangeText={setQuery} maxLength={1024} placeholder={t('Search names and descriptions')} placeholderTextColor={c.faint} style={[s.search, { color: c.text, backgroundColor: c.raised }]} />{!filtered.length && <Text style={[type.caption, { color: c.quiet }]}>{t(query ? 'No matching skills' : 'No skills yet')}</Text>}{filtered.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={t('View skill {name}', { name: row.name })} disabled={working} onPress={() => { setSearchOpen(false); setQuery(''); void open(row); }} style={({ pressed }) => [s.skillRow, pressed && { backgroundColor: c.wash }, working && { opacity: .35 }]}><Icon name="spark" color={row.enabled && row.status === 'active' ? c.accent : c.quiet} size={20} /><View style={s.rowMeta}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{row.description}</Text><Text style={[type.micro, { color: row.error ? c.danger : c.quiet }]}>{t(row.status === 'deleting' ? 'Deletion needs retry' : row.status === 'removed' ? 'Source directory removed' : row.status !== 'active' ? 'Skill unavailable' : row.enabled ? 'Enabled' : 'Disabled')}</Text></View></Pressable>)}</ScrollView></View>}
    </View>
  </SafeAreaView></KeyboardAvoidingView>
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  headerAction: { minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerDivider: { width: 1, height: 12, alignSelf: 'center' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: -20, paddingHorizontal: 20 },
  skillRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: -20, paddingHorizontal: 20, paddingVertical: 8 },
  rowMeta: { flex: 1, minWidth: 0, gap: 3 },
  emptyBody: { flexGrow: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'center', gap: 10, paddingBottom: 60 },
  emptyAsk: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, marginTop: 6 },
  search: { ...type.body, minHeight: 44, paddingHorizontal: 12, borderRadius: 12, marginVertical: 6 },
  definition: { borderRadius: 10, padding: 12, marginTop: 8 },
  editorShell: { minHeight: 380, borderRadius: 10, marginTop: 8 },
});
