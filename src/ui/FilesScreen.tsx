import { BusyIndicator } from './BusyIndicator';
import { useTheme } from './appearance';
import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, FlatList, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Rxd, { type FileEntry, type FilePreview, type FileRoot } from '../../modules/rxd';
import { MAX_IMPORT_BYTES } from '../workspace/limits.ts';
import { useI18n } from '../i18n/index.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import type { LibraryFile } from '../workspace/files';
import { CodeBlock } from './CodeText';
import { CodeEditor } from './CodeEditor';
import { Icon, type IconName } from './Icon';
import { languageForFile } from './highlight';
import { type Colors } from './theme';
import { type } from './type';

type Place = 'library' | FileRoot;
type Browse = 'root' | 'termux' | Place;
const mounts = ['library', 'skills', 'workspace', 'termux'] as const;
type Selection = { library: LibraryFile; entry?: never } | { entry: FileEntry; library?: never };
type Row = { kind: 'library'; record: LibraryFile } | { kind: 'entry'; entry: FileEntry };
const names: Record<Place, string> = { library: 'chats', skills: 'skills', workspace: 'workspace', home: 'home', runtime: 'usr' };
const mountNotes: Record<'library' | 'skills' | 'workspace' | 'termux', string> = { library: '对话附件与保存产物 · 只读', skills: '共享技能 · 可写', workspace: '任务工作区 · 可写', termux: 'Termux 根 · home/usr' };
const termuxNotes: Record<'home' | 'runtime', string> = { home: 'Shell Home · 可写', runtime: '运行时程序与库 · 只读' };
const size = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;

function FileButton({ icon, title, onPress, disabled, c, danger = false }: { icon: IconName; title: string; onPress: () => void; disabled: boolean; c: Colors; danger?: boolean }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(title)} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, pressed && !disabled && { opacity: .55 }, disabled && { opacity: .4 }]}><Icon name={icon} color={danger ? c.danger : c.quiet} size={18} /><Text style={[type.label, { color: danger ? c.danger : c.text }]}>{t(title)}</Text></Pressable>;
}

function RowAction({ icon, title, onPress, disabled, c, danger = false }: { icon: IconName; title: string; onPress: () => void; disabled: boolean; c: Colors; danger?: boolean }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(title)} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.rowAction, pressed && !disabled && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}><Icon name={icon} color={danger ? c.danger : c.quiet} size={18} /><Text style={[type.body, { color: danger ? c.danger : c.text }]}>{t(title)}</Text></Pressable>;
}

export default function FilesScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ root?: string; path?: string }>();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [place, setPlace] = useState<Browse>(() => params.root === 'skills' || params.root === 'workspace' || params.root === 'home' || params.root === 'runtime' ? params.root : 'root');
  const [path, setPath] = useState(() => typeof params.path === 'string' ? params.path : '');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [selection, setSelection] = useState<Selection>();
  const [preview, setPreview] = useState<FilePreview>();
  const [usage, setUsage] = useState<Awaited<ReturnType<Workspace['fileLibrary']['usage']>>>([]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [dialog, setDialog] = useState<'new-file' | 'new-folder' | 'rename' | 'copy'>();
  const [moving, setMoving] = useState<{ root: FileRoot; path: string; folders: FileEntry[]; loading: boolean; error: string }>();
  const [target, setTarget] = useState('');
  const [targetRoot, setTargetRoot] = useState<FileRoot>('workspace');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const lock = useRef(false);
  const selectedRequest = useRef(0);
  const moveRequest = useRef(0);
  const firstLoad = useRef(params.root !== undefined);
  const { c } = useTheme();
  const busy = snapshot?.conversations.some((conversation) => conversation.busy) ?? false;
  const label = selection?.library?.file.name ?? selection?.entry?.name ?? t('文件');
  const mutable = !!selection?.entry?.writable && !busy;

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((core) => {
      if (!alive.current) return;
      setWorkspace(core); setSnapshot(core.getSnapshot());
      unsubscribe = core.subscribe(setSnapshot);
    }).catch((failure) => { if (alive.current) setError(String(failure)); });
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!workspace || place === 'root' || place === 'termux') return;
    let active = true;
    // The first batch waits for the native stack transition; applying it mid-slide
    // mounts every row while the incoming screen is still animating.
    const delay = firstLoad.current ? 300 : 120;
    firstLoad.current = false;
    const timer = setTimeout(() => {
      const request = place === 'library' ? workspace.fileLibrary.list(query) : Rxd.listFiles(place, path, 0, query);
      void request.then((value) => {
        if (!active) return;
        if ('files' in value) { setFiles(value.files); setEntries([]); } else { setEntries(value.entries); setFiles([]); }
        setOffset(value.nextOffset); setLoading(false);
      }).catch((failure) => { if (active) { setError(String(failure)); setLoading(false); } });
    }, delay);
    return () => { active = false; clearTimeout(timer); };
  }, [workspace, place, path, query, version, busy]);



  function reload() { setLoading(true); setVersion((value) => value + 1); }
  function navigate(next: Browse, directory = '') {
    selectedRequest.current++;
    setSelection(undefined); setPreview(undefined); setEditing(false); setError(''); setNotice('');
    const virtual = next === 'root' || next === 'termux';
    setPlace(next); setPath(virtual ? '' : directory); setQuery(''); setFiles([]); setEntries([]); setOffset(null);
    setLoading(!virtual); setVersion((value) => value + 1);
  }
  function back() {
    if (moving) { closeMove(); return; }
    if (dialog) { setDialog(undefined); setError(''); return; }
    if (editing && text !== preview?.text) { Alert.alert(t('放弃未保存的更改？'), '', [{ text: t('取消') }, { text: t('放弃更改'), style: 'destructive', onPress: () => { setEditing(false); setText(preview?.text ?? ''); } }]); return; }
    if (selection) { selectedRequest.current++; setSelection(undefined); setPreview(undefined); setEditing(false); setError(''); }
    else if (path && place !== 'root' && place !== 'termux') navigate(place, path.split('/').slice(0, -1).join('/'));
    else if (place === 'home' || place === 'runtime') navigate('termux');
    else if (place !== 'root') navigate('root');
    else router.back();
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (moving || dialog || selection || path || place !== 'root') { back(); return true; }
      return false;
    });
    return () => listener.remove();
  });

  async function perform(action: () => Promise<void>, refresh = true) {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (alive.current) setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); }
    finally { lock.current = false; if (alive.current) { setWorking(false); if (refresh) reload(); } }
  }
  async function choose(value: Selection) {
    const request = ++selectedRequest.current;
    setSelection(value); setPreview(undefined); setEditing(false); setUsage([]);
    await perform(async () => {
      const result = value.library ? value.library.status === 'active' ? await Rxd.readCapture(value.library.file.uri, value.library.file.sha256) : { text: null, sha256: null, size: value.library.file.size, reason: 'deleted' }
        : value.entry.kind === 'file' ? await Rxd.readFile(value.entry.root, value.entry.path) : { text: null, sha256: null, size: value.entry.size, reason: value.entry.kind };
      const references = value.library ? await workspace!.fileLibrary.usage(value.library.file.id) : [];
      if (alive.current && request === selectedRequest.current) { setPreview(result); setText(result.text ?? ''); setUsage(references); }
    }, false);
  }
  async function importFile() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, multiple: false });
    if (picked.canceled || !workspace) return;
    await perform(async () => {
      const asset = picked.assets[0];
      const file = await Rxd.importFile(asset.uri, asset.name, snapshot?.importLimit ?? MAX_IMPORT_BYTES);
      await workspace.fileLibrary.remember(file);
      if (place !== 'library' && place !== 'root' && place !== 'termux') await Rxd.copyCapture(file.uri, file.sha256, place, join(path, file.name));
      setNotice(t('已导入文件库'));
    });
  }
  async function loadMove(root: FileRoot, path: string) {
    const request = ++moveRequest.current;
    setMoving((old) => old ? { ...old, root, path, loading: true, error: '' } : old);
    try {
      const page = await Rxd.listFiles(root, path, 0, '');
      if (!alive.current || request !== moveRequest.current) return;
      setMoving((old) => old ? { ...old, folders: page.entries.filter((entry) => entry.kind === 'directory'), loading: false } : old);
    } catch (failure) {
      if (alive.current && request === moveRequest.current) setMoving((old) => old ? { ...old, loading: false, error: String(failure).replace(/^Error: /, '').slice(0, 1000) } : old);
    }
  }
  function openMove() {
    if (!selection?.entry) return;
    const parent = selection.entry.path.split('/').slice(0, -1).join('/');
    const root: FileRoot = selection.entry.root === 'home' ? 'home' : 'workspace';
    const path = root === selection.entry.root ? parent : '';
    setMoving({ root, path, folders: [], loading: true, error: '' });
    void loadMove(root, path);
  }
  function closeMove() { moveRequest.current++; setMoving(undefined); }
  function form(kind: NonNullable<typeof dialog>) {
    setDialog(kind); setTarget(kind === 'rename' ? label : kind === 'new-file' || kind === 'new-folder' ? '' : selection?.entry?.path ?? label);
    setTargetRoot(place === 'home' ? 'home' : 'workspace');
  }
  async function apply() {
    await perform(async () => {
      if (busy) throw new Error(t('请先停止正在运行的任务'));
      if (!target.trim()) throw new Error(t('请输入文件名或路径'));
      const value = target.trim();
      if (dialog === 'rename' && selection?.library) await workspace!.fileLibrary.rename(selection.library.file.id, value);
      else if (dialog === 'new-file' && place !== 'library' && place !== 'runtime' && place !== 'root' && place !== 'termux') await Rxd.writeFile(place, join(path, value), '', '');
      else if (dialog === 'new-folder' && place !== 'library' && place !== 'runtime' && place !== 'root' && place !== 'termux') await Rxd.createDirectory(place, join(path, value));
      else if (dialog === 'rename' && selection?.entry) await Rxd.moveFile(selection.entry.root, selection.entry.path, selection.entry.root, join(selection.entry.path.split('/').slice(0, -1).join('/'), value));
      else if (dialog === 'copy' && selection?.library) await Rxd.copyCapture(selection.library.file.uri, selection.library.file.sha256, targetRoot, value);
      else if (dialog === 'copy' && selection?.entry) await Rxd.copyFile(selection.entry.root, selection.entry.path, targetRoot, value);
      setDialog(undefined); setSelection(undefined); setPreview(undefined); setNotice(t('文件操作已完成'));
    });
  }
  function remove() {
    if (!selection) return;
    Alert.alert(t('删除 {name}？', { name: label }), selection.library ? t('文件会从本机移除，{count} 个会话的附件将不可用；消息和工具结果保留。', { count: usage.length }) : t(selection.entry.kind === 'directory' ? '文件夹及其中内容会被删除，此操作无法撤销。' : selection.entry.kind === 'symlink' ? '仅删除符号链接，目标文件保留。' : '文件会被删除，此操作无法撤销。'), [
      { text: t('取消') }, { text: t('删除'), style: 'destructive', onPress: () => { void perform(async () => {
        if (busy) throw new Error(t('请先停止正在运行的任务'));
        if (selection.library) await workspace!.fileLibrary.remove(selection.library.file.id);
        else await Rxd.deleteFile(selection.entry.root, selection.entry.path);
        setSelection(undefined); setPreview(undefined);
      }); } },
    ]);
  }
  async function attach() {
    if (!selection || !workspace) return;
    await perform(async () => {
      const file = selection.library ? selection.library.file : await workspace.captureFile(selection.entry.root, selection.entry.path);
      await workspace.attachExisting(file.id);
      router.navigate({ pathname: '/', params: { attachmentId: file.id, prompt: t('分析这个文件的结构与关键入口。'), composeId: globalThis.crypto.randomUUID() } });
    });
  }
  async function share() {
    if (!selection) return;
    await perform(async () => {
      if (!await Sharing.isAvailableAsync()) throw new Error(t('当前设备没有可用的分享方式'));
      const uri = selection.library ? await Rxd.shareCapture(selection.library.file.uri, selection.library.file.sha256, label) : await Rxd.shareFile(selection.entry.root, selection.entry.path);
      await Sharing.shareAsync(uri, { dialogTitle: label });
    });
  }
  async function saveText() {
    if (!selection?.entry || !preview?.sha256 || busy) return;
    await perform(async () => {
      await Rxd.writeFile(selection.entry.root, selection.entry.path, text, preview.sha256!);
      const value = await Rxd.readFile(selection.entry.root, selection.entry.path);
      setPreview(value); setEditing(false); setNotice(t('已保存更改'));
    });
  }
  async function more() {
    if (offset === null || !workspace || place === 'root' || place === 'termux') return;
    await perform(async () => {
      if (place === 'library') { const page = await workspace.fileLibrary.list(query, offset); setFiles((old) => [...old, ...page.files]); setOffset(page.nextOffset); }
      else { const page = await Rxd.listFiles(place, path, offset, query); setEntries((old) => [...old, ...page.entries]); setOffset(page.nextOffset); }
    }, false);
  }
  const readable = selection?.library ? selection.library.status === 'active' : selection?.entry.kind === 'file';
  const rows = useMemo<Row[]>(() => place === 'library'
    ? files.map((record) => ({ kind: 'library', record }))
    : place === 'root' || place === 'termux' ? [] : entries.map((entry) => ({ kind: 'entry', entry })), [place, files, entries]);
  const segments = path.split('/').filter(Boolean);
  const rootName = place === 'library' ? names.library : place === 'root' ? t('文件') : place === 'termux' ? 'termux' : names[place];
  const crumbLabels = [rootName, ...(place === 'library' || place === 'root' || place === 'termux' ? [] : segments)];
  const crumbs = crumbLabels.map((full, index) => ({ full, short: index === 0 && crumbLabels.length > 1 ? full.slice(0, 1) : full, target: index === 0 ? '' : segments.slice(0, index).join('/'), current: index === crumbLabels.length - 1 }));
  const rootLabel = (root: FileRoot) => root === 'home' ? 'home' : root === 'skills' ? 'skills' : 'workspace';
  const moveSegments = moving?.path.split('/').filter(Boolean) ?? [];
  const moveLabels = moving ? [rootLabel(moving.root), ...moveSegments] : [];
  const moveCrumbs = moveLabels.map((full, index) => ({ full, target: index === 0 ? '' : moveSegments.slice(0, index).join('/'), current: index === moveLabels.length - 1 }));
  const sourceParent = selection?.entry ? selection.entry.path.split('/').slice(0, -1).join('/') : '';
  const sameDestination = !!moving && !!selection?.entry && moving.root === selection.entry.root && moving.path === sourceParent;
  const insideSource = !!moving && !!selection?.entry && selection.entry.kind === 'directory' && moving.root === selection.entry.root && (moving.path === selection.entry.path || moving.path.startsWith(selection.entry.path + '/'));
  const canMove = !!moving && !!selection?.entry && !moving.loading && !sameDestination && !insideSource && !working && !busy;
  async function applyMove() {
    if (!selection?.entry || !moving || !canMove) return;
    await perform(async () => {
      await Rxd.moveFile(selection.entry.root, selection.entry.path, moving.root, join(moving.path, selection.entry.name));
      closeMove(); setSelection(undefined); setPreview(undefined); setNotice(t('文件操作已完成'));
    });
  }
  const dialogTitle = dialog === 'new-file' ? t('新建文件') : dialog === 'new-folder' ? t('新建文件夹') : dialog === 'copy' ? t('复制到') : t('重命名');
  const rootOptions = ['workspace', 'home'] as const;
  return <KeyboardAvoidingView behavior="height" style={s.screen}><SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={t('返回')} onPress={back} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>{moving ? <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{t('移动到')}</Text> : dialog ? <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{dialogTitle}</Text> : selection ? <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{label}</Text> : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.crumbScroll} contentContainerStyle={s.crumbs}>{crumbs.map((crumb, index) => <View key={`${crumb.full}-${index}`} style={s.crumbPart}>{index > 0 && <Text style={[type.heading, { color: c.quiet }]}>/</Text>}<Pressable accessibilityRole="button" accessibilityLabel={crumb.full} disabled={crumb.current} onPress={() => navigate(place, crumb.target)} style={({ pressed }) => [pressed && !crumb.current && { opacity: .55 }]}><Text numberOfLines={1} style={[type.heading, { color: crumb.current ? c.heading : c.quiet }]}>{crumb.short}</Text></Pressable></View>)}</ScrollView>}{moving && <Pressable accessibilityRole="button" accessibilityLabel={t('移动到这里')} testID="files-move-here" disabled={!canMove} onPress={() => { void applyMove(); }} style={({ pressed }) => [s.headerIcon, pressed && canMove && { opacity: .55 }, !canMove && { opacity: .35 }]}><Icon name="check" color={c.accent} size={19} /></Pressable>}{!moving && !dialog && !selection && place !== 'root' && place !== 'termux' && <View style={s.headerActions}>{place !== 'runtime' && <Pressable accessibilityRole="button" accessibilityLabel={t('导入')} testID="files-import" disabled={!workspace || busy || working} onPress={() => { void importFile(); }} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (!workspace || busy || working) && { opacity: .35 }]}><Icon name="plus" color={c.text} size={19} /></Pressable>}{place !== 'runtime' && place !== 'library' && <><View style={[s.headerDivider, { backgroundColor: c.line }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('新建文件')} testID="files-new-file" disabled={busy || working} onPress={() => form('new-file')} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (busy || working) && { opacity: .35 }]}><Icon name="file" color={c.text} size={19} /></Pressable><View style={[s.headerDivider, { backgroundColor: c.line }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('新建文件夹')} testID="files-new-folder" disabled={busy || working} onPress={() => form('new-folder')} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (busy || working) && { opacity: .35 }]}><Icon name="folder" color={c.text} size={19} /></Pressable></>}</View>}{!moving && !dialog && selection && !editing && <View style={s.headerActions}><Pressable accessibilityRole="button" accessibilityLabel={t('分享文件')} disabled={!readable || working} onPress={() => { void share(); }} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (!readable || working) && { opacity: .35 }]}><Icon name="share" color={c.text} size={19} /></Pressable><View style={[s.headerDivider, { backgroundColor: c.line }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('复制到')} disabled={!readable || busy || working} onPress={() => form('copy')} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (!readable || busy || working) && { opacity: .35 }]}><Icon name="copy" color={c.text} size={19} /></Pressable><View style={[s.headerDivider, { backgroundColor: c.line }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('重命名')} disabled={busy || (selection.entry ? !mutable : selection.library.status !== 'active') || working} onPress={() => form('rename')} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (busy || (selection.entry ? !mutable : selection.library.status !== 'active') || working) && { opacity: .35 }]}><Icon name="edit" color={c.text} size={19} /></Pressable></View>}{working && <BusyIndicator color={c.accent} />}{editing && !moving && !dialog && <FileButton icon="check" title="保存更改" onPress={() => { void saveText(); }} disabled={busy || working} c={c} />}</View>
    {!!error && <Text selectable style={[s.message, { color: c.danger }]}>{error}</Text>}
    {!!notice && <Text style={[s.message, { color: c.accent }]}>{notice}</Text>}
    {moving ? <View style={s.moveScreen}>
      <ScrollView contentContainerStyle={s.moveBody} keyboardShouldPersistTaps="handled">
        <View style={[s.inlineGroup, { paddingHorizontal: 20, marginTop: 8 }]}>{rootOptions.map((root) => <Pressable key={root} accessibilityRole="button" accessibilityLabel={rootLabel(root)} onPress={() => { void loadMove(root, ''); }} style={({ pressed }) => [s.inlineOption, pressed && { opacity: .55 }]}><Text style={[type.label, { color: moving.root === root ? c.accent : c.text }]}>{rootLabel(root)}</Text>{moving.root === root && <Icon name="check" size={15} color={c.accent} />}</Pressable>)}</View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.detailCrumbScroll, { flexGrow: 0 }]} contentContainerStyle={s.crumbs}>{moveCrumbs.map((crumb, index) => <View key={`${crumb.full}-${index}`} style={s.crumbPart}>{index > 0 && <Text style={[type.heading, { color: c.quiet }]}>/</Text>}<Pressable accessibilityRole="button" accessibilityLabel={crumb.full} disabled={crumb.current} onPress={() => { if (!crumb.current) void loadMove(moving.root, crumb.target); }} style={({ pressed }) => [pressed && !crumb.current && { opacity: .55 }]}><Text numberOfLines={1} style={[type.heading, { color: crumb.current ? c.heading : c.quiet }]}>{crumb.full}</Text></Pressable></View>)}</ScrollView>
        {!!moving.error && <Text selectable style={[s.message, { color: c.danger }]}>{moving.error}</Text>}
        {moving.loading ? <View style={s.moveEmpty}><BusyIndicator color={c.accent} /></View> : moving.folders.length ? moving.folders.map((folder) => <Pressable key={folder.path} accessibilityRole="button" accessibilityLabel={t('打开 {name}', { name: folder.name })} disabled={working} onPress={() => { void loadMove(moving.root, folder.path); }} style={({ pressed }) => [s.fileRow, pressed && { backgroundColor: c.wash }]}><Icon name="folder" color={c.accent} /><View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>{folder.name}</Text><Text style={[type.micro, { color: c.quiet }]}>{t('文件夹')}</Text></View></Pressable>) : <Text style={[s.message, { color: c.quiet }]}>{t('这里没有子文件夹')}</Text>}
      </ScrollView>
    </View> : dialog ? <ScrollView contentContainerStyle={s.dialogBody} keyboardShouldPersistTaps="handled">
      {dialog === 'copy' && <View style={s.inlineGroup}>{rootOptions.map((root) => <Pressable key={root} accessibilityRole="button" accessibilityLabel={rootLabel(root)} onPress={() => setTargetRoot(root)} style={({ pressed }) => [s.inlineOption, pressed && { opacity: .55 }]}><Text style={[type.label, { color: targetRoot === root ? c.accent : c.text }]}>{rootLabel(root)}</Text>{targetRoot === root && <Icon name="check" size={15} color={c.accent} />}</Pressable>)}</View>}
      <Text style={[s.fieldLabel, { color: c.quiet }]}>{t('文件名或目标路径')}</Text>
      <TextInput accessibilityLabel={t('文件名或目标路径')} value={target} onChangeText={setTarget} maxLength={4096} autoCapitalize="none" autoCorrect={false} placeholder={t('文件名或目标路径')} placeholderTextColor={c.faint} style={[s.input, { color: c.text, backgroundColor: c.raised }]} />
      <View style={s.dialogActions}><FileButton icon="close" title="取消" onPress={() => setDialog(undefined)} disabled={working} c={c} /><FileButton icon="check" title="确定" onPress={() => { void apply(); }} disabled={busy || working} c={c} /></View>
    </ScrollView> : !selection ? <>
      {place === 'root' ? <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {mounts.map((mount) => <Pressable key={mount} accessibilityRole="button" accessibilityLabel={t(mount === 'termux' ? 'termux' : names[mount])} onPress={() => navigate(mount)} style={({ pressed }) => [s.fileRow, pressed && { backgroundColor: c.wash }]}>
          <Icon name={mount === 'library' ? 'disk' : mount === 'skills' ? 'spark' : mount === 'termux' ? 'terminal' : 'folder'} color={mount === 'library' ? c.quiet : c.accent} />
          <View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>{mount === 'termux' ? 'termux' : names[mount]}</Text><Text style={[type.micro, { color: c.quiet }]}>{t(mountNotes[mount])}</Text></View>
        </Pressable>)}
      </ScrollView> : place === 'termux' ? <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel={t('home')} onPress={() => navigate('home')} style={({ pressed }) => [s.fileRow, pressed && { backgroundColor: c.wash }]}><Icon name="folder" color={c.accent} /><View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>home</Text><Text style={[type.micro, { color: c.quiet }]}>{t(termuxNotes.home)}</Text></View></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('usr')} onPress={() => navigate('runtime')} style={({ pressed }) => [s.fileRow, pressed && { backgroundColor: c.wash }]}><Icon name="code" color={c.quiet} /><View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>usr</Text><Text style={[type.micro, { color: c.quiet }]}>{t(termuxNotes.runtime)}</Text></View></Pressable>
      </ScrollView> : <>
      {place !== 'library' && <Pressable accessibilityRole="button" accessibilityLabel={t('交给 Agent')} disabled={working} onPress={() => router.navigate({ pathname: '/', params: { prompt: t('请查看 {place} 中的路径“{path}”，先询问我希望进行的操作，不要直接修改文件。', { place: t(names[place]), path: path || '/' }), composeId: globalThis.crypto.randomUUID() } })} style={({ pressed }) => [s.agentBar, pressed && { backgroundColor: c.wash }, working && { opacity: .4 }]}><Icon name="chat" color={c.accent} size={18} /><Text style={[type.body, { color: c.text }]}>{t('交给 Agent')}</Text></Pressable>}
      <TextInput accessibilityLabel={t('搜索文件名')} value={query} maxLength={240} onChangeText={(value) => { setQuery(value); setLoading(true); }} placeholder={t('搜索文件名')} placeholderTextColor={c.faint} style={[s.search, { color: c.text }]} />
      {busy && <Text style={[s.message, { color: c.quiet }]}>{t('任务运行中，完成后可修改文件。')}</Text>}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={[s.body, !rows.length && s.emptyBody]}
        keyboardShouldPersistTaps="handled"
        data={rows}
        keyExtractor={(item) => item.kind === 'library' ? item.record.file.id : item.entry.path}
        ListEmptyComponent={loading ? <View style={s.empty}><BusyIndicator color={c.accent} /></View> : <View style={s.empty}><Text style={[s.message, { color: c.quiet }]}>{t(query ? '没有匹配的文件' : '这里还没有文件')}</Text></View>}
        ListFooterComponent={offset !== null ? <View style={s.footer}><FileButton icon={'plus'} title={'加载更多'} onPress={() => { void more(); }} disabled={working} c={c} /></View> : undefined}
        renderItem={({ item }) => item.kind === 'library'
          ? <Pressable accessibilityRole="button" accessibilityLabel={t('查看文件 {name}', { name: item.record.file.name })} disabled={working} onPress={() => { void choose({ library: item.record }); }} style={({ pressed }) => [s.fileRow, pressed && { backgroundColor: c.wash }]}><Icon name="file" color={c.accent} /><View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>{item.record.file.name}</Text><Text style={[type.micro, { color: c.quiet }]}>{item.record.status === 'deleting' ? t('删除待重试') : item.record.origin === 'generated' ? t('已保存产物') : t('导入快照')} · {size(item.record.file.size)}</Text></View></Pressable>
          : <View style={s.fileRow}><Pressable accessibilityRole="button" accessibilityLabel={t('打开 {name}', { name: item.entry.name })} disabled={working} onPress={() => { if (item.entry.kind === 'directory') navigate(item.entry.root, item.entry.path); else void choose({ entry: item.entry }); }} style={({ pressed }) => [s.fileMain, pressed && { opacity: .55 }]}><Icon name={item.entry.kind === 'directory' ? 'folder' : 'file'} color={c.quiet} /><View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>{item.entry.name}</Text><Text style={[type.micro, { color: c.quiet }]}>{item.entry.kind === 'directory' ? t('文件夹') : item.entry.kind === 'symlink' ? t('符号链接') : size(item.entry.size)}</Text></View></Pressable><Pressable accessibilityRole="button" accessibilityLabel={t('管理 {name}', { name: item.entry.name })} disabled={working} onPress={() => { void choose({ entry: item.entry }); }} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="more" color={c.quiet} /></Pressable></View>}
      />
      </>}
    </> : <>
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      {selection.library && <Text selectable style={[s.path, { color: c.quiet }]}>{`${t(selection.library.origin === 'generated' ? '已保存产物' : '导入快照')} · ${size(selection.library.file.size)}\nSHA-256: ${selection.library.file.sha256}`}</Text>}
      {selection.library?.error && <Text style={[s.message, { color: c.danger }]}>{selection.library.error}</Text>}
      {!editing && <View style={s.actionGrid}>
        <RowAction icon="chat" title="用于对话" onPress={() => { void attach(); }} disabled={!readable || busy || working} c={c} />
        {selection.entry && <RowAction icon="folder" title="移动到" onPress={openMove} disabled={!mutable || working} c={c} />}
        {selection.entry && preview?.text !== null && preview?.text !== undefined && <RowAction icon="edit" title="编辑文本" onPress={() => setEditing(true)} disabled={!mutable || working} c={c} />}
        <RowAction icon="trash" title={selection.library?.status === 'deleting' ? '重试删除' : '删除文件'} onPress={remove} disabled={busy || (selection.entry ? !mutable : false) || working} c={c} danger />
      </View>}
      {selection.library && <><Text style={[s.section, { color: c.heading }]}>{t('关联会话 · {count}', { count: usage.length })}</Text>{usage.slice(0, 20).map((item) => <Pressable key={String(item.id)} accessibilityRole="button" disabled={!item.listed} onPress={() => { void workspace!.select(item.id).then(() => router.navigate('/')); }} style={s.reference}><Text style={[type.caption, { color: c.quiet }]}>{item.title}{item.listed ? '' : ` · ${t('已移出历史')}`}</Text></Pressable>)}{usage.length > 20 && <Text style={[s.referenceText, { color: c.quiet }]}>{t('另有 {count} 个关联会话', { count: usage.length - 20 })}</Text>}<Text style={[s.message, { color: c.quiet }]}>{t('快照保持不可变。需要编辑时，先复制到 workspace。')}</Text></>}
      {preview?.text !== null && preview?.text !== undefined ? editing ? <CodeEditor text={text} language={languageForFile(selection?.entry?.path ?? selection?.library?.file.name ?? '')} c={c} editable={!working} maxLength={262144} label={t('文件内容')} onChangeText={setText} style={s.editorShell} /> : <View style={[s.preview, { backgroundColor: c.code }]}><CodeBlock code={preview.text || t('（空文件）')} language={languageForFile(selection?.entry?.path ?? selection?.library?.file.name ?? '')} c={c} /></View> : <Text style={[s.message, { color: c.quiet }]}>{preview?.reason === 'directory' ? t('文件夹内容可从列表打开') : preview?.reason === 'symlink' ? t('符号链接不会被跟随') : t('此文件没有文本预览，可复制、分享或作为附件使用。')}</Text>}
    </ScrollView></>}
  </SafeAreaView></KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 12 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  path: { ...type.caption, marginHorizontal: 20, marginVertical: 10 },
  search: { ...type.body, minHeight: 40, marginHorizontal: 20, marginVertical: 6, paddingVertical: 8 },
  crumbScroll: { flex: 1 }, crumbs: { flexDirection: 'row', alignItems: 'center' }, crumbPart: { flexDirection: 'row', alignItems: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' }, headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, headerDivider: { width: 1, height: 12 },
  agentBar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 20 },
  moveScreen: { flex: 1 }, moveBody: { paddingBottom: 24 }, moveEmpty: { paddingVertical: 36, alignItems: 'center' }, moveFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 20 },
  detailCrumbScroll: { marginHorizontal: 20, marginVertical: 8 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }, rowAction: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 20 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  body: { paddingBottom: 35 }, emptyBody: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 24 },
  footer: { paddingHorizontal: 20, paddingTop: 8, alignItems: 'flex-start' },
  message: { ...type.caption, marginHorizontal: 20, marginVertical: 10 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 20, paddingVertical: 8 },
  fileMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  section: { ...type.label, marginTop: 20, marginBottom: 10, paddingHorizontal: 20 },
  reference: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 },
  referenceText: { ...type.caption, paddingHorizontal: 20, marginTop: 4 },
  preview: { padding: 14, marginHorizontal: 20, marginTop: 14, borderRadius: 12 },
  editorShell: { minHeight: 300, marginHorizontal: 20, marginTop: 14, borderRadius: 12 },
  dialogBody: { paddingHorizontal: 20, paddingBottom: 40 },
  inlineGroup: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 12 },
  inlineOption: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 },
  fieldLabel: { ...type.caption, marginTop: 20, marginBottom: 8 },
  input: { ...type.body, minHeight: 48, paddingHorizontal: 0, paddingVertical: 10 },
  dialogActions: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 12 },
});
