import { BusyIndicator } from './BusyIndicator';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Rxd from '../../modules/rxd';
import { useI18n } from '../i18n/index.ts';
import type { McpCatalogItem, McpDefinition, McpTool } from '../workspace/service-types';
import { Icon, type IconName } from './Icon';
import { type Colors } from './theme';
import { type } from './type';
import { ServiceFrame, ui, useServiceWorkspace } from './ServiceUi';

function McpAction({ icon, label, action, c, disabled = false, danger = false, testID }: { icon: IconName; label: string; action: () => void; c: Colors; disabled?: boolean; danger?: boolean; testID?: string }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} testID={testID} disabled={disabled} onPress={action} style={({ pressed }) => [ms.row, pressed && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}><Icon name={icon} color={danger ? c.danger : c.quiet} size={18} /><Text style={[type.list, { color: danger ? c.danger : c.text }]}>{t(label)}</Text></Pressable>;
}
function McpSearch({ value, change, c, placeholder, autoFocus = false }: { value: string; change: (value: string) => void; c: Colors; placeholder: string; autoFocus?: boolean }) {
  const { t } = useI18n();
  return <View style={[ms.search, { backgroundColor: c.code }]}><Icon name="search" color={c.faint} size={17} /><TextInput autoFocus={autoFocus} accessibilityLabel={t(placeholder)} value={value} onChangeText={change} autoCorrect={false} autoCapitalize="none" maxLength={512} placeholder={t(placeholder)} placeholderTextColor={c.faint} style={[type.body, { color: c.text, flex: 1, paddingVertical: 0 }]} /></View>;
}
function McpSection({ label, c }: { label: string; c: Colors }) { const { t } = useI18n(); return <Text style={[type.eyebrow, { color: c.faint, marginTop: 22, marginBottom: 2 }]}>{t(label)}</Text>; }

const REFRESH_SECONDS = 5;
const LAYER_MS = 140;
function RefreshBars({ left, c }: { left: number; c: Colors }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>{Array.from({ length: REFRESH_SECONDS }, (_, index) => <View key={index} style={{ width: 2, height: 7, borderRadius: 1, backgroundColor: index < left ? c.accent : c.line }} />)}</View>;
}

type Edit = { original?: string; text: string };
const MCP_TEMPLATE = `{
  "server-name": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  }
}
`;
function parseMcpDocument(text: string | null): { document: Record<string, unknown>; servers: Record<string, unknown> } {
  if (!text) return { document: { mcpServers: {} }, servers: {} };
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mcp.json 必须包含一个 JSON 对象');
  const raw = (parsed as { mcpServers?: unknown }).mcpServers;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('mcp.json 的 mcpServers 必须是对象');
  return { document: parsed as Record<string, unknown>, servers: (raw ?? {}) as Record<string, unknown> };
}
function validateMcpEntries(entries: Record<string, unknown>) {
  const names = Object.keys(entries);
  if (!names.length) throw new Error('至少填写一个 MCP');
  for (const name of names) {
    if (!name.trim() || name.length > 80) throw new Error('MCP 名称必须是 1–80 个字符');
    const value = entries[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP "${name}" 必须是对象`);
    const server = value as Record<string, unknown>;
    if (typeof server.url === 'string') {
      try {
        const url = new URL(server.url);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || server.url.length > 4096) throw new Error();
      } catch { throw new Error(`MCP "${name}" 的 url 必须是 HTTP/HTTPS 地址`); }
    } else if (typeof server.command !== 'string' || !server.command.trim()) {
      throw new Error(`MCP "${name}" 需要 command 或 url`);
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) throw new Error(`MCP "${name}" 的 args 必须是字符串数组`);
    for (const key of ['headers', 'env'] as const) {
      const object = server[key];
      if (object !== undefined && (!object || typeof object !== 'object' || Array.isArray(object) || Object.values(object).some((item) => typeof item !== 'string'))) throw new Error(`MCP "${name}" 的 ${key} 必须是字符串对象`);
    }
  }
}
const ms = StyleSheet.create({
  headerDivider: { width: 1, height: 12, alignSelf: 'center' },
  headerGroup: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' },
  headerClose: { position: 'absolute', right: 0, top: 0, width: 44, height: 44, zIndex: 1 },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, marginHorizontal: -20 },
  listRow: { minHeight: 64, alignItems: 'flex-start', paddingVertical: 10 },
  toolRow: { minHeight: 0, alignItems: 'flex-start', paddingVertical: 10 },
  search: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 12, paddingHorizontal: 12, marginVertical: 4 },
  actions: { marginTop: 10 },
  pager: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4 },
  codeBlock: { ...type.code, padding: 12, borderRadius: 10, marginTop: 6 },
  layer: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, zIndex: 20 },
  searchLayerBody: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 24 },
  configBody: { flex: 1, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 24 },
  emptyBody: { flexGrow: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'center', gap: 10, paddingBottom: 60 },
  emptyAsk: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, marginTop: 6 },
  configInput: { ...type.code, flex: 1, minHeight: 260, borderRadius: 10, padding: 12, marginTop: 10, textAlignVertical: 'top' },
  configSave: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
});

const HEADER_ACTIONS_WIDTH = 3 * 44 + 2;
function McpHeaderActions({ active, locked, closeLabel, closeTestID, c, working, services, onNew, onConfig, onSearch, onClose }: { active: boolean; locked: boolean; closeLabel: string; closeTestID: string; c: Colors; working: boolean; services: boolean; onNew: () => void; onConfig: () => void; onSearch: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [progress] = useState(() => new Animated.Value(active ? 1 : 0));
  useEffect(() => {
    Animated.timing(progress, { toValue: active ? 1 : 0, duration: LAYER_MS, useNativeDriver: true }).start();
    return () => progress.stopAnimation();
  }, [active, progress]);
  const groupOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  return <View style={{ width: HEADER_ACTIONS_WIDTH, height: 44 }}>
    <Animated.View pointerEvents={active || locked ? 'none' : 'auto'} accessibilityElementsHidden={active || locked} importantForAccessibility={active || locked ? 'no-hide-descendants' : 'auto'} style={[ms.headerGroup, { opacity: groupOpacity }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Add MCP')} testID="mcp-new" disabled={working || !services} onPress={onNew} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, (working || !services) && { opacity: .35 }]}><Icon name="plus" color={c.text} size={19} /></Pressable>
      <View style={[ms.headerDivider, { backgroundColor: c.line }]} />
      <Pressable accessibilityRole="button" accessibilityLabel={t('Pi configuration file')} testID="mcp-config" disabled={!services} onPress={onConfig} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }, !services && { opacity: .35 }]}><Icon name="folder" color={c.text} size={19} /></Pressable>
      <View style={[ms.headerDivider, { backgroundColor: c.line }]} />
      <Pressable accessibilityRole="button" accessibilityLabel={t('Search MCP')} testID="mcp-search" onPress={onSearch} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="search" color={c.text} size={19} /></Pressable>
    </Animated.View>
    <Animated.View pointerEvents={active ? 'auto' : 'none'} accessibilityElementsHidden={!active} importantForAccessibility={!active ? 'no-hide-descendants' : 'auto'} style={[ms.headerClose, { opacity: progress }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} testID={closeTestID} onPress={onClose} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="close" color={c.text} size={19} /></Pressable>
    </Animated.View>
  </View>;
}

function McpLayer({ open, background, children }: { open: boolean; background: string; children: ReactNode }) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(progress, { toValue: open ? 1 : 0, duration: LAYER_MS, useNativeDriver: true }).start();
    return () => progress.stopAnimation();
  }, [open, progress]);
  return <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[ms.layer, { backgroundColor: background, opacity: progress }]}>{children}</Animated.View>;
}

const connectionLabel = { connecting: '正在连接', connected: '已连接', disconnected: '已断开', failed: '连接失败' };
type ToolPage = { tools: (McpTool & { alias: string })[]; total: number; nextOffset: number | null };
export default function McpScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <McpView key={id ?? 'list'} initialId={id} />;
}
function McpView({ initialId }: { initialId?: string }) {
  const { t } = useI18n();
  const { services, c, palette, error, setError, working, perform, alive } = useServiceWorkspace();
  const [records, setRecords] = useState<McpCatalogItem[]>([]), [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(initialId), [edit, setEdit] = useState<Edit>();
  const [toolQuery, setToolQuery] = useState('');
  const [left, setLeft] = useState(REFRESH_SECONDS);
  const refreshPending = useRef(false), remaining = useRef(REFRESH_SECONDS);
  const [tools, setTools] = useState<ToolPage>(), [toolOffset, setToolOffset] = useState(0), [selectedTool, setSelectedTool] = useState<McpTool>();
  const [notice, setNotice] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [config, setConfig] = useState<{ text: string; sha256: string }>();
  const [configBusy, setConfigBusy] = useState(false), [configError, setConfigError] = useState('');
  const [closing, setClosing] = useState(false);
  const [editError, setEditError] = useState(''), [editBusy, setEditBusy] = useState(false);
  const selected = records.find((row) => row.id === selectedId);
  const refresh = useCallback(async () => { if (!services) return; const rows = await services.mcp.list(); if (alive.current) { setRecords(rows); setLoading(false); } }, [services, alive]);
  const refreshNow = useCallback(async () => {
    if (refreshPending.current || !services) return;
    remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS);
    refreshPending.current = true;
    try { await refresh(); }
    catch (failure) { if (alive.current) { setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); setLoading(false); } }
    finally { refreshPending.current = false; if (alive.current) { remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); } }
  }, [refresh, services, alive, setError]);
  function choose(id?: string) { setSelectedId(id); setTools(undefined); setSelectedTool(undefined); setToolQuery(''); setToolOffset(0); }
  useFocusEffect(useCallback(() => {
    let focused = true;
    remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); void refreshNow();
    const unsubscribe = services?.mcp.subscribe(() => { if (focused) void refreshNow(); });
    const timer = setInterval(() => {
      if (!focused) return;
      remaining.current -= 1;
      if (remaining.current <= 0) { remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); void refreshNow(); }
      else setLeft(remaining.current);
    }, 1000);
    return () => { focused = false; clearInterval(timer); unsubscribe?.(); };
  }, [refreshNow, services]));
  function back() {
    if (edit || configOpen || searchOpen) { closeLayer(); return; }
    if (selectedId) { choose(undefined); setNotice(''); setError(''); return; }
    router.back();
  }
  useEffect(() => { const listener = BackHandler.addEventListener('hardwareBackPress', () => { if (edit || configOpen || searchOpen) { Keyboard.dismiss(); setClosing(true); return true; } if (selectedId) { choose(undefined); setNotice(''); setError(''); return true; } return false; }); return () => listener.remove(); }, [configOpen, searchOpen, edit, selectedId, setError]);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => {
      setClosing(false);
      setEdit(undefined);
      setConfigOpen(false);
      setSearchOpen(false);
      setQuery('');
    }, LAYER_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  async function loadConfig() {
    setSearchOpen(false); setClosing(false);
    setConfigOpen(true); setConfigBusy(true); setConfigError('');
    try {
      const file = await Rxd.readFile('home', '.pi/agent/mcp.json');
      setConfig(file.text === null ? { text: '{\n  "mcpServers": {}\n}\n', sha256: '' } : { text: file.text, sha256: file.sha256 ?? '' });
    } catch (failure) {
      if (alive.current) setConfigError(String(failure).replace(/^Error: /, '').slice(0, 1000));
    } finally {
      if (alive.current) setConfigBusy(false);
    }
  }
  async function saveConfig() {
    if (!services || !config) return;
    setConfigBusy(true); setConfigError('');
    try {
      const parsed: unknown = JSON.parse(config.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mcp.json 必须包含一个 JSON 对象');
      const servers = (parsed as { mcpServers?: unknown }).mcpServers;
      if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('mcp.json 的 mcpServers 必须是对象');
      await Rxd.writeFile('home', '.pi/agent/mcp.json', config.text, config.sha256);
      const written = await Rxd.readFile('home', '.pi/agent/mcp.json');
      if (written.sha256 === null) throw new Error('Pi MCP configuration was not written');
      setConfig({ ...config, sha256: written.sha256 });
      await services.mcp.reload();
      await refresh();
      if (alive.current) { setClosing(true); setNotice(t('Pi configuration saved')); }
    } catch (failure) {
      if (alive.current) setConfigError(String(failure).replace(/^Error: /, '').slice(0, 1000));
    } finally {
      if (alive.current) setConfigBusy(false);
    }
  }
  async function openEdit(row?: McpDefinition) {
    setError(''); setNotice(''); setClosing(false); setEditError('');
    try {
      const file = await Rxd.readFile('home', '.pi/agent/mcp.json');
      const { servers } = parseMcpDocument(file.text);
      if (row) {
        const value = servers[row.name];
        if (value === undefined) throw new Error('mcp.json 中没有这个 MCP，请先刷新配置');
        setEdit({ original: row.name, text: JSON.stringify({ [row.name]: value }, null, 2) + '\n' });
      } else {
        setEdit({ text: MCP_TEMPLATE });
      }
    } catch (failure) {
      if (alive.current) setError(String(failure).replace(/^Error: /, '').slice(0, 1000));
    }
  }
  async function saveEdit() {
    if (!edit || !services || editBusy) return;
    setEditBusy(true); setEditError('');
    try {
      const parsed: unknown = JSON.parse(edit.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请输入一个 JSON 对象');
      const additions = parsed as Record<string, unknown>;
      validateMcpEntries(additions);
      const file = await Rxd.readFile('home', '.pi/agent/mcp.json');
      const { document, servers } = parseMcpDocument(file.text);
      if (edit.original && !(edit.original in servers)) throw new Error('mcp.json 中没有这个 MCP，请关闭后刷新');
      if (edit.original && !(edit.original in additions)) delete servers[edit.original];
      Object.assign(servers, additions);
      const text = JSON.stringify({ ...document, mcpServers: servers }, null, 2) + '\n';
      await Rxd.writeFile('home', '.pi/agent/mcp.json', text, file.sha256 ?? '');
      const written = await Rxd.readFile('home', '.pi/agent/mcp.json');
      if (written.sha256 === null) throw new Error('Pi MCP configuration was not written');
      await services.mcp.reload();
      await refresh();
      const rows = await services.mcp.list();
      const first = Object.keys(additions)[0];
      const found = rows.find((row) => row.name === first);
      if (found) choose(found.id);
      setClosing(true); setNotice(t('MCP configuration saved'));
    } catch (failure) {
      if (alive.current) setEditError(String(failure).replace(/^Error: /, '').slice(0, 1000));
    } finally {
      if (alive.current) setEditBusy(false);
    }
  }
  async function loadTools(offset = 0, refreshCatalog = false) {
    if (!services || !selected) return;
    const id = selected.id;
    await perform(async () => {
      if (refreshCatalog) await services.mcp.discover(id);
      const result = await services.mcp.tools(id, toolQuery, offset);
      if (alive.current) { setTools(result); setToolOffset(offset); setSelectedTool(undefined); }
      await refresh();
    });
  }
  function remove() {
    if (!selected) return;
    Alert.alert(t('Delete MCP configuration?'), t('Removes tool access and credentials. The linked process keeps running.'), [{ text: t('Cancel') }, { text: t('Delete'), style: 'destructive', onPress: () => { void perform(async () => { await services!.mcp.remove(selected.id); choose(undefined); setTools(undefined); await refresh(); }); } }]);
  }
  const filtered = records.filter((row) => `${row.name}\n${row.url ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const layerKind = edit ? 'edit' : configOpen ? 'config' : searchOpen ? 'search' : undefined;
  function closeLayer() {
    if (closing) return;
    Keyboard.dismiss();
    setClosing(true);
  }
  return <ServiceFrame title={selected?.name ?? 'MCP'} c={c} palette={palette} error={error} working={working} back={back} right={<McpHeaderActions active={!!layerKind && !closing} locked={closing} closeLabel={t(layerKind === 'edit' ? 'Close editor' : layerKind === 'config' ? 'Close Pi configuration' : 'Close search')} closeTestID={layerKind === 'edit' ? 'mcp-edit-close' : layerKind === 'config' ? 'mcp-config-close' : 'mcp-search-close'} c={c} working={working} services={!!services} onNew={() => { void openEdit(); }} onConfig={() => { void loadConfig(); }} onSearch={() => { setConfigOpen(false); setSearchOpen(true); setQuery(''); }} onClose={closeLayer} />}>
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={!selected && !loading && !records.length ? [ui.body, ms.emptyBody] : ui.body} keyboardShouldPersistTaps="handled">
      {!!notice && <Text style={[type.caption, { color: c.quiet, marginTop: 4 }]}>{t(notice)}</Text>}
      {selected ? <>
        <Text style={[type.caption, { color: c.quiet }]}>{selected.enabled ? t('Enabled') : t('Disabled')} · {selected.connection ? t(connectionLabel[selected.connection.state]) : t('Not connected')} · {selected.transport === 'stdio' ? 'stdio' : 'HTTP'}</Text>
        {!!selected.policyBlocked && <Text style={[type.caption, { color: c.danger }]}>{t('Plaintext HTTP MCP is off. Enable it in Settings to connect.')}</Text>}
        <Text selectable style={[type.code, { color: c.text, marginTop: 12 }]}>{selected.id}</Text>
        {selected.url && <Text selectable style={[type.body, { color: c.text, marginTop: 4 }]}>{selected.url}</Text>}
        <Text style={[type.micro, { color: c.quiet, marginTop: 8 }]}>{t('Tools')} {selected.toolCount ?? '—'} · {t('Version')} {selected.revision} · {selected.hasCredential ? t('Credential saved') : t('No credential')}</Text>
        {!!selected.connection?.protocolVersion && <Text style={[type.micro, { color: c.quiet }]}>{selected.connection.protocolVersion}</Text>}
        {!!(selected.error || selected.connection?.reason) && <Text style={[type.caption, { color: c.danger, marginTop: 8 }]}>{t(selected.error || selected.connection?.reason || '')}</Text>}
        <View style={ms.actions}>
          <McpAction icon={selected.enabled ? 'close' : 'check'} label={selected.enabled ? '停用 MCP' : '启用 MCP'} c={c} testID="mcp-toggle" disabled={working} action={() => { void perform(async () => { await services!.mcp.enabled(selected.id, !selected.enabled); setTools(undefined); await refresh(); }); }} />
          <McpAction icon="plug" label="Connect" c={c} disabled={working || !selected.enabled || selected.policyBlocked} action={() => { void perform(async () => { await services!.mcp.connect(selected.id); await refresh(); setNotice(t('Protocol initialized; tool definitions load on demand.')); }); }} />
          <McpAction icon="power" label="Disconnect" c={c} disabled={working || !selected.connection || selected.connection.state === 'disconnected'} action={() => { void perform(async () => { await services!.mcp.disconnect(selected.id); setTools(undefined); await refresh(); setNotice(t('Disconnected; the linked process keeps running.')); }); }} />
          <McpAction icon="edit" label="Edit configuration" c={c} disabled={working} action={() => { void openEdit(selected); }} />
          <McpAction icon="trash" label="Delete configuration" danger c={c} disabled={working} action={remove} />
        </View>
        {selected.transport === 'http' && <View style={ms.actions}>
          <McpAction icon="user" label="Sign in with OAuth" c={c} testID="mcp-oauth-login" disabled={working || !selected.url} action={() => { void perform(async () => { await services!.mcp.signIn(selected.id); await refresh(); setNotice(t('OAuth sign-in complete')); }); }} />
          <McpAction icon="power" label="Sign out of OAuth" c={c} disabled={working || !selected.url} action={() => { void perform(async () => { await services!.mcp.signOut(selected.id); await refresh(); setNotice(t('OAuth credential removed')); }); }} />
        </View>}
        {(selected.launch || selected.definitionId || selected.processId) && <>
          <McpSection label="Local process" c={c} />
          {selected.processId && <Text selectable style={[type.code, { color: c.quiet }]}>{selected.processId}</Text>}
          {(selected.serviceDefinitionId || selected.definitionId) && <Text selectable style={[type.code, { color: c.quiet }]}>{selected.serviceDefinitionId || selected.definitionId}</Text>}
          {selected.processId && <McpAction icon="terminal" label="View linked process" c={c} testID="mcp-process" action={() => router.push({ pathname: '/processes', params: { id: selected.processId } })} />}
          {(selected.launch || selected.definitionId) && <>
            <Text selectable style={[ms.codeBlock, { color: c.text, backgroundColor: c.code }]}>{selected.launch?.argv ? JSON.stringify(selected.launch.argv) : selected.launch?.script ?? selected.definitionId}</Text>
            <McpAction icon="terminal" label="Start local process" c={c} testID="mcp-start" disabled={working} action={() => { void perform(async () => { const record = await services!.mcp.start(selected.id, `ui-mcp-${globalThis.crypto.randomUUID()}`); await refresh(); setNotice(`${t('Process startup admitted')} · ${record.id}`); }); }} />
          </>}
        </>}
        <McpSection label="Tools" c={c} />
        <McpSearch value={toolQuery} change={setToolQuery} c={c} placeholder={t('Search tools')} />
        <View style={ms.actions}>
          <McpAction icon="search" label="Discover tools" c={c} testID="mcp-discover" disabled={working || !selected.enabled || selected.policyBlocked} action={() => { void loadTools(0, true); }} />
          <McpAction icon="filter" label="Search discovered tools" c={c} disabled={working || !selected.enabled || selected.policyBlocked} action={() => { void loadTools(); }} />
        </View>
        {!tools && <Text style={[type.caption, { color: c.quiet, marginTop: 8 }]}>{t('Tools not loaded yet')}</Text>}
        {tools?.tools.map((tool) => <Pressable key={tool.name} accessibilityRole="button" accessibilityLabel={`${t('View tool')} ${tool.name}`} onPress={() => setSelectedTool(selectedTool?.name === tool.name ? undefined : tool)} style={({ pressed }) => [ms.row, ms.toolRow, pressed && { opacity: .55 }]}>
          <View style={{ flex: 1, minWidth: 0 }}><Text style={[type.body, { color: c.heading }]}>{tool.name}</Text>{!!tool.description && <Text numberOfLines={2} style={[type.caption, { color: c.quiet }]}>{tool.description}</Text>}{selectedTool?.name === tool.name && <Text testID="mcp-tool-schema" selectable style={[ms.codeBlock, { color: c.text, backgroundColor: c.code }]}>{JSON.stringify({ name: tool.name, alias: tool.alias, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, null, 2)}</Text>}</View>
        </Pressable>)}
        {tools && <View style={ms.pager}><Pressable accessibilityRole="button" accessibilityLabel={t('Previous tools')} disabled={working || !toolOffset || !selected.enabled} onPress={() => { void loadTools(Math.max(0, toolOffset - 8)); }} style={({ pressed }) => [pressed && { opacity: .55 }, (working || !toolOffset || !selected.enabled) && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t('Previous tools')}</Text></Pressable><Text style={[type.micro, { color: c.quiet }]}>{toolOffset + 1}–{toolOffset + tools.tools.length} / {tools.total}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Next tools')} disabled={working || tools.nextOffset === null || !selected.enabled} onPress={() => { void loadTools(tools.nextOffset!); }} style={({ pressed }) => [pressed && { opacity: .55 }, (working || tools.nextOffset === null || !selected.enabled) && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t('Next tools')}</Text></Pressable></View>}
      </> : <>
        {loading ? <Text style={[type.caption, { color: c.quiet }]}>{t('Loading')}</Text> : records.length ? <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text style={[type.caption, { color: c.quiet }]}>{t('{count} MCP servers', { count: records.length })}</Text>
          <RefreshBars left={left} c={c} />
        </View> : <View style={ms.emptyState}>
          <Text style={[type.heading, { color: c.heading, textAlign: 'center' }]}>{t('No MCP servers yet')}</Text>
          <Text style={[type.caption, { color: c.quiet, textAlign: 'center', maxWidth: 300 }]}>{t('Use + in the top right to add MCP, or edit the Pi configuration from the folder.')}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Ask the agent to configure MCP')} testID="mcp-empty-ask" onPress={() => router.navigate({ pathname: '/', params: { prompt: t('I want to configure an MCP. Ask me which service to connect, then help me edit the Pi configuration and verify it.'), composeId: globalThis.crypto.randomUUID() } })} style={({ pressed }) => [ms.emptyAsk, pressed && { opacity: .55 }]}><Icon name="chat" color={c.accent} size={18} /><Text style={[type.label, { color: c.accent }]}>{t('Ask the agent to configure MCP')}</Text></Pressable>
        </View>}
        {records.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`${t('View MCP')} ${row.name}`} onPress={() => { choose(row.id); setNotice(''); }} style={({ pressed }) => [ms.row, ms.listRow, pressed && { backgroundColor: c.wash }]}>
          <Icon name="grid" color={row.enabled ? c.accent : c.quiet} size={20} />
          <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.micro, { color: c.quiet }]}>{row.enabled ? t('Enabled') : t('Disabled')} · {row.connection ? t(connectionLabel[row.connection.state]) : t('Not connected')} · {row.transport === 'stdio' ? 'stdio' : 'HTTP'}</Text>{!!(row.url ?? row.processId) && <Text numberOfLines={1} style={[type.micro, { color: c.quiet }]}>{row.url ?? row.processId}</Text>}{!!row.error && <Text numberOfLines={2} style={[type.caption, { color: c.danger }]}>{row.error}</Text>}</View>
        </Pressable>)}
      </>}
    </ScrollView>
    {edit && <McpLayer open={!closing} background={c.background}><View style={ms.configBody}><Text style={[type.eyebrow, { color: c.faint }]}>{t(edit.original ? 'Edit MCP' : 'Add MCP')}</Text><Text selectable style={[type.caption, { color: c.quiet, marginTop: 4 }]}>~/.pi/agent/mcp.json</Text>{!!editError && <Text style={[type.caption, { color: c.danger, marginTop: 8 }]}>{editError}</Text>}<TextInput testID="mcp-edit-json" accessibilityLabel={t('MCP JSON')} value={edit.text} onChangeText={(text) => setEdit((old) => old ? { ...old, text } : old)} multiline autoCorrect={false} autoCapitalize="none" style={[ms.configInput, { color: c.text, backgroundColor: c.code }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('Save configuration')} testID="mcp-edit-save" disabled={editBusy} onPress={() => { void saveEdit(); }} style={({ pressed }) => [ms.configSave, { backgroundColor: c.accent }, pressed && { opacity: .82 }, editBusy && { opacity: .4 }]}><Text style={[type.label, { color: c.onAccent }]}>{t('Save configuration')}</Text></Pressable></View></McpLayer>}
    {searchOpen && <McpLayer open={!closing} background={c.background}><ScrollView contentContainerStyle={ms.searchLayerBody} keyboardShouldPersistTaps="handled"><McpSearch value={query} change={setQuery} c={c} placeholder={t('Search MCP')} autoFocus />{!filtered.length && <Text style={[type.caption, { color: c.quiet, marginTop: 8 }]}>{t(query ? 'No matching MCP servers' : 'No MCP servers yet')}</Text>}{filtered.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`${t('View MCP')} ${row.name}`} onPress={() => { choose(row.id); setClosing(true); setNotice(''); }} style={({ pressed }) => [ms.row, ms.listRow, pressed && { backgroundColor: c.wash }]}><Icon name="grid" color={row.enabled ? c.accent : c.quiet} size={20} /><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{row.name}</Text><Text numberOfLines={1} style={[type.micro, { color: c.quiet }]}>{row.enabled ? t('Enabled') : t('Disabled')} · {row.connection ? t(connectionLabel[row.connection.state]) : t('Not connected')} · {row.transport === 'stdio' ? 'stdio' : 'HTTP'}</Text>{!!(row.url ?? row.processId) && <Text numberOfLines={1} style={[type.micro, { color: c.quiet }]}>{row.url ?? row.processId}</Text>}{!!row.error && <Text numberOfLines={2} style={[type.caption, { color: c.danger }]}>{row.error}</Text>}</View></Pressable>)}</ScrollView></McpLayer>}
    {configOpen && <McpLayer open={!closing} background={c.background}><View style={ms.configBody}><Text style={[type.eyebrow, { color: c.faint }]}>{t('Pi configuration')}</Text><Text selectable style={[type.caption, { color: c.quiet, marginTop: 4 }]}>~/.pi/agent/mcp.json</Text>{!!configError && <Text style={[type.caption, { color: c.danger, marginTop: 8 }]}>{configError}</Text>}{configBusy && !config ? <BusyIndicator color={c.accent} /> : config && <><TextInput testID="mcp-config-editor" accessibilityLabel={t('Pi configuration file')} value={config.text} onChangeText={(text) => setConfig({ ...config, text })} multiline autoCorrect={false} autoCapitalize="none" style={[ms.configInput, { color: c.text, backgroundColor: c.code }]} /><Pressable accessibilityRole="button" accessibilityLabel={t('Save configuration')} testID="mcp-config-save" disabled={configBusy} onPress={() => { void saveConfig(); }} style={({ pressed }) => [ms.configSave, { backgroundColor: c.accent }, pressed && { opacity: .82 }, configBusy && { opacity: .4 }]}><Text style={[type.label, { color: c.onAccent }]}>{t('Save configuration')}</Text></Pressable></>}{configBusy && config && <BusyIndicator color={c.accent} size="small" />}</View></McpLayer>}
    </View>
  </ServiceFrame>;
}
