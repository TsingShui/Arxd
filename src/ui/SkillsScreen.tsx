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
      Alert.alert(t('放弃未保存的更改？'), '', [{ text: t('取消') }, { text: t('放弃更改'), style: 'destructive', onPress: () => { setEditor(false); setText(definition?.definition ?? ''); } }]); return;
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
    await perform(async () => { const row = await workspace!.skills.import(archive ? 'archive' : 'file', asset.uri); setSelected(row); const body = await workspace!.skills.working(row.id); setDefinition(body); setText(body.definition); setNotice(t('技能已导入，默认停用')); });
  }
  async function save() {
    if (!selected || !definition) return;
    await perform(async () => { const row = await workspace!.skills.save(selected.id, text, definition.sha256); setSelected(row); setDefinition(await workspace!.skills.working(row.id)); setEditor(false); setNotice(t('技能已更新')); });
  }
  function remove() {
    if (!selected) return;
    Alert.alert(t('删除技能 {name}？', { name: selected.name }), t('会删除技能目录及资源；会话消息和已有工具记录保留。'), [{ text: t('取消') }, { text: t('删除'), style: 'destructive', onPress: () => { void perform(async () => { await workspace!.skills.remove(selected.id); setSelected(undefined); setDefinition(undefined); }); } }]);
  }
  const filtered = records.filter((row) => `${row.name}\n${row.description}`.toLowerCase().includes(query.toLowerCase()));
  return <KeyboardAvoidingView behavior="height" style={s.screen}><SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('返回')} onPress={back} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{selected?.name ?? t('技能')}</Text>
      {searchOpen ? <Pressable accessibilityRole="button" accessibilityLabel={t('关闭搜索')} testID="skill-search-close" onPress={() => { setSearchOpen(false); setQuery(''); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="close" color={c.text} size={19} /></Pressable> : editor ? <Pressable accessibilityRole="button" accessibilityLabel={t('保存技能')} disabled={working || busy} onPress={() => { void save(); }} style={({ pressed }) => [s.headerAction, pressed && { opacity: .55 }, (working || busy) && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t('保存技能')}</Text></Pressable> : <View style={s.headerActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('导入技能')} testID="skill-import-file" disabled={working || busy || !workspace} onPress={() => { void importFile(); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || busy || !workspace) && { opacity: .35 }]}><Icon name="file" color={c.text} size={19} /></Pressable>
        <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('刷新技能')} testID="skill-refresh" disabled={working || !workspace} onPress={() => { void perform(async () => { setRecords(await workspace!.skills.refresh()); }); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || !workspace) && { opacity: .35 }]}><Icon name="refresh" color={c.text} size={19} /></Pressable>
        <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('搜索技能')} testID="skill-search" onPress={() => { setQuery(''); setSearchOpen(true); }} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="search" color={c.text} size={19} /></Pressable>
      </View>}
    </View>
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={!selected && !loading && !filtered.length ? [ui.body, s.emptyBody] : ui.body} keyboardShouldPersistTaps="handled">
      {!!error && <Text selectable style={[type.caption, { color: c.danger }]}>{error}</Text>}
      {!!notice && <Text style={[type.caption, { color: c.accent }]}>{notice}</Text>}
      {!selected ? <>
        {loading && <Text style={[type.caption, { color: c.quiet }]}>{t('加载中')}</Text>}
        {!loading && !filtered.length && <View style={s.emptyState}>
          <Text style={[type.heading, { color: c.heading, textAlign: 'center' }]}>{t('还没有安装技能')}</Text>
          <Text style={[type.caption, { color: c.quiet, textAlign: 'center', maxWidth: 300 }]}>{t('点击右上角的文件图标，导入 SKILL.md 或 .zip')}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('让 Agent 安装技能')} testID="skill-empty-ask" onPress={() => router.navigate({ pathname: '/', params: { prompt: t('我想安装一个技能。请先问我需要什么能力，再检查当前环境，帮助我安装并验证。'), composeId: globalThis.crypto.randomUUID() } })} style={({ pressed }) => [s.emptyAsk, pressed && { opacity: .55 }]}><Icon name="chat" color={c.accent} size={18} /><Text style={[type.label, { color: c.accent }]}>{t('让 Agent 安装技能')}</Text></Pressable>
        </View>}
        {filtered.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={t('查看技能 {name}', { name: row.name })} disabled={working} onPress={() => { void open(row); }} style={({ pressed }) => [s.skillRow, pressed && { backgroundColor: c.wash }, working && { opacity: .35 }]}><Icon name="spark" color={row.enabled && row.status === 'active' ? c.accent : c.quiet} size={20} /><View style={s.rowMeta}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{row.description}</Text><Text style={[type.micro, { color: row.error ? c.danger : c.quiet }]}>{t(row.status === 'deleting' ? '删除待重试' : row.status === 'removed' ? '源目录已移除' : row.status !== 'active' ? '技能不可用' : row.enabled ? '已启用' : '已停用')}</Text></View></Pressable>)}
      </> : <>
        <Text style={[type.body, { color: c.text }]}>{selected.description}</Text>
        {!!selected.compatibility && <Text style={[type.caption, { color: c.quiet }]}>{selected.compatibility}</Text>}
        {!!selected.license && <Text style={[type.caption, { color: c.quiet }]}>{t('许可：{license}', { license: selected.license })}</Text>}
        {!!selected.allowedTools && <Text style={[type.caption, { color: c.quiet }]}>{t('技能声明的工具（不增加权限）：{tools}', { tools: selected.allowedTools })}</Text>}
        <Text selectable style={[type.micro, { color: c.quiet }]}>{t('来源：{source}', { source: selected.source === 'file' ? t('说明文件') : selected.source === 'archive' ? t('压缩包') : selected.source === 'tree' ? t('设备目录') : selected.source === 'shell' ? 'Shell' : t('工作区') })}{' · '}{t('版本：{version}', { version: selected.version.slice(0, 12) })}{'\n'}{selected.path}</Text>
        {!!selected.error && <Text style={[type.caption, { color: c.danger }]}>{selected.error}</Text>}
        <SkillRow icon="check" title={selected.enabled ? '停用技能' : '启用技能'} disabled={working || busy || (selected.status === 'deleting' || selected.status === 'removed')} c={c} action={() => { void perform(async () => { setSelected(await workspace!.skills.enabled(selected.id, !selected.enabled)); }); }} />
        <SkillRow icon="chat" title={chosen ? '取消会话选择' : '用于当前会话'} disabled={working || busy || (!chosen && (!selected.enabled || selected.status !== 'active'))} c={c} action={() => { void perform(async () => { await workspace!.skills.choose(selected.id, !chosen); if (!chosen) router.navigate('/'); }); }} />
        <SkillRow icon="edit" title="编辑技能说明" disabled={working || busy || !definition || selected.status === 'deleting'} c={c} action={() => setEditor(true)} />
        <SkillRow icon="folder" title="管理脚本与资源" disabled={working || selected.status === 'deleting'} c={c} action={() => router.push({ pathname: '/files', params: { root: 'skills', path: selected.path } })} />
        <SkillRow icon="trash" title="删除技能" danger disabled={working || busy} c={c} action={remove} />
        {editor ? <TextInput accessibilityLabel={t('技能说明内容')} value={text} onChangeText={setText} multiline editable={!working} autoCorrect={false} autoCapitalize="none" maxLength={65536} style={[s.editor, { color: c.text, backgroundColor: c.code }]} /> : <Text selectable style={[s.definition, { color: c.text, backgroundColor: c.code }]}>{definition?.definition ?? t('技能说明不可用')}</Text>}
      </>}
    </ScrollView>
    {searchOpen && <View style={[StyleSheet.absoluteFill, { backgroundColor: c.background }]}><ScrollView contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled"><TextInput autoFocus accessibilityLabel={t('搜索技能')} value={query} onChangeText={setQuery} maxLength={1024} placeholder={t('搜索名称与用途')} placeholderTextColor={c.faint} style={[s.search, { color: c.text, backgroundColor: c.raised }]} />{!filtered.length && <Text style={[type.caption, { color: c.quiet }]}>{t(query ? '没有匹配的技能' : '还没有技能')}</Text>}{filtered.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={t('查看技能 {name}', { name: row.name })} disabled={working} onPress={() => { setSearchOpen(false); setQuery(''); void open(row); }} style={({ pressed }) => [s.skillRow, pressed && { backgroundColor: c.wash }, working && { opacity: .35 }]}><Icon name="spark" color={row.enabled && row.status === 'active' ? c.accent : c.quiet} size={20} /><View style={s.rowMeta}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{row.description}</Text><Text style={[type.micro, { color: row.error ? c.danger : c.quiet }]}>{t(row.status === 'deleting' ? '删除待重试' : row.status === 'removed' ? '源目录已移除' : row.status !== 'active' ? '技能不可用' : row.enabled ? '已启用' : '已停用')}</Text></View></Pressable>)}</ScrollView></View>}
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
  definition: { ...type.code, borderRadius: 10, padding: 12, marginTop: 8 },
  editor: { ...type.code, minHeight: 380, padding: 12, borderRadius: 10, textAlignVertical: 'top', marginTop: 8 },
});
