import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useI18n } from '../i18n/index.ts';
import type { McpCatalogItem, ProcessLog, ProcessRecord } from '../workspace/service-types';
import { BusyIndicator } from './BusyIndicator';
import { Icon, type IconName } from './Icon';
import { type Colors } from './theme';
import { type } from './type';
import { processLabel, ServiceFrame, useServiceWorkspace } from './ServiceUi';

const REFRESH_SECONDS = 5;
function date(value?: number) { return value ? new Date(value).toLocaleString() : '—'; }
function RefreshBars({ left, c }: { left: number; c: Colors }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>{Array.from({ length: REFRESH_SECONDS }, (_, index) => <View key={index} style={{ width: 2, height: 7, borderRadius: 1, backgroundColor: index < left ? c.accent : c.line }} />)}</View>;
}
function MetaRow({ label, value, c }: { label: string; value: string; c: Colors }) {
  const { t } = useI18n();
  return <View style={s.metaRow}><Text style={[type.caption, { color: c.quiet }]}>{t(label)}</Text><Text selectable numberOfLines={2} style={[type.mono, { color: c.text, flex: 1, textAlign: 'right' }]}>{value}</Text></View>;
}
function Action({ label, icon, onPress, c, testID, disabled = false, danger = false }: { label: string; icon: IconName; onPress: () => void; c: Colors; testID?: string; disabled?: boolean; danger?: boolean }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} testID={testID} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.action, pressed && !disabled && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}><Icon name={icon} size={18} color={danger ? c.danger : c.quiet} /><Text style={[type.body, { color: danger ? c.danger : c.text }]}>{t(label)}</Text></Pressable>;
}
function TextAction({ label, onPress, c, active = false, danger = false, disabled = false, testID }: { label: string; onPress: () => void; c: Colors; active?: boolean; danger?: boolean; disabled?: boolean; testID?: string }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} testID={testID} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.textAction, pressed && { opacity: .55 }, disabled && { opacity: .4 }]}><Text style={[type.label, { color: danger ? c.danger : active ? c.accent : c.quiet }]}>{t(label)}</Text>{active && <Icon name="check" size={14} color={c.accent} />}</Pressable>;
}
function Field({ label, value, onChange, c, disabled }: { label: string; value: string; onChange: (value: string) => void; c: Colors; disabled: boolean }) {
  const { t } = useI18n();
  return <View style={s.field}><Text style={[type.caption, { color: c.quiet }]}>{t(label)}</Text><TextInput testID={`service-field-${label}`} accessibilityLabel={t(label)} value={value} onChangeText={onChange} multiline editable={!disabled} maxLength={16384} autoCorrect={false} autoCapitalize="none" style={[s.input, { color: c.text, backgroundColor: c.raised }]} /></View>;
}

export default function ProcessesScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ProcessesView key={id ?? 'list'} initialId={id} />;
}
function ProcessesView({ initialId }: { initialId?: string }) {
  const { t } = useI18n();
  const { services, c, palette, error, setError, working, perform, alive } = useServiceWorkspace();
  const [records, setRecords] = useState<ProcessRecord[]>([]);
  const [selected, setSelected] = useState<ProcessRecord>();
  const [selectedId, setSelectedId] = useState(initialId), [loading, setLoading] = useState(true);
  const [left, setLeft] = useState(REFRESH_SECONDS);
  const [linked, setLinked] = useState<McpCatalogItem[]>([]);
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stderr');
  const [log, setLog] = useState(''), [logPage, setLogPage] = useState<ProcessLog>();
  const [logLoaded, setLogLoaded] = useState(false), [follow, setFollow] = useState(false), [rawLog, setRawLog] = useState(false);
  const [input, setInput] = useState(''), [newline, setNewline] = useState(true);
  const logPending = useRef(false);
  const refreshPending = useRef(false), remaining = useRef(REFRESH_SECONDS);
  const cursor = useRef(0), logEpoch = useRef(0), decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  const [notice, setNotice] = useState('');
  const selection = useRef(selectedId);
  const active = selected && ['queued', 'starting', 'running', 'stopping'].includes(selected.state);
  const protocol = !!selected?.protocolOwner;
  const endpoints = selected && 'endpoints' in selected && Array.isArray(selected.endpoints) ? selected.endpoints.filter((value): value is string => typeof value === 'string') : [];
  const refresh = useCallback(async () => {
    if (!services) return;
    const rows: ProcessRecord[] = [];
    let offset = 0;
    for (let page = 0; page < 8; page++) {
      const result = await services.processes.list(offset, 32);
      rows.push(...result.items);
      if (result.nextOffset === null) break;
      offset = result.nextOffset;
    }
    const [detail, mcps] = await Promise.all([selectedId ? services.processes.inspect(selectedId) : undefined, selectedId ? services.mcp.list() : []]);
    if (!alive.current) return;
    setRecords(rows); if (selection.current === selectedId) setSelected(detail); setLoading(false);
    if (selection.current === selectedId) setLinked(mcps.filter((row) => row.processId === selectedId));
  }, [services, selectedId, alive]);
  const refreshNow = useCallback(async () => {
    if (refreshPending.current) return;
    remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS);
    refreshPending.current = true;
    try { await refresh(); }
    catch (failure) { if (alive.current) { setError(String(failure).replace(/^Error: /, '').slice(0, 1000)); setLoading(false); } }
    finally { refreshPending.current = false; if (alive.current) { remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); } }
  }, [refresh, alive, setError]);
  useFocusEffect(useCallback(() => {
    let focused = true;
    remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); void refreshNow();
    const timer = setInterval(() => {
      if (!focused) return;
      remaining.current -= 1;
      if (remaining.current <= 0) { remaining.current = REFRESH_SECONDS; setLeft(REFRESH_SECONDS); void refreshNow(); }
      else setLeft(remaining.current);
    }, 1000);
    return () => { focused = false; clearInterval(timer); };
  }, [refreshNow]));
  function resetLogs() { logEpoch.current++; cursor.current = 0; decoder.current = new TextDecoder('utf-8', { fatal: true }); setLog(''); setLogPage(undefined); setLogLoaded(false); setFollow(false); setInput(''); }
  function choose(id?: string) { selection.current = id; setSelectedId(id); resetLogs(); }
  function logStream(value: 'stdout' | 'stderr') { setStream(value); resetLogs(); }
  function back() { if (selectedId) { choose(undefined); setSelected(undefined); setError(''); setNotice(''); return; } router.back(); }
  useEffect(() => { const listener = BackHandler.addEventListener('hardwareBackPress', () => { if (selectedId) { back(); return true; } return false; }); return () => listener.remove(); });
  async function readLog(reset = false) {
    if (!services || !selectedId || (protocol && stream === 'stdout')) return;
    if (logPending.current) return;
    logPending.current = true;
    try {
    const token = logEpoch.current;
    const result = await services.processes.logs(selectedId, stream, reset ? 0 : cursor.current, 16384);
    if (!alive.current || token !== logEpoch.current) return;
    if (reset || result.droppedBytes > 0) decoder.current = new TextDecoder('utf-8', { fatal: true });
    let value: string;
    try {
      const bytes = Uint8Array.from(globalThis.atob(result.base64), (char) => char.charCodeAt(0));
      value = result.text ?? decoder.current.decode(bytes, { stream: true });
    } catch { value = `${t('Binary or non-UTF-8 content, Base64:')}\n${result.base64}\n`; decoder.current = new TextDecoder('utf-8', { fatal: true }); }
    cursor.current = result.nextCursor; setLogPage(result); setLogLoaded(true);
    setLog((old) => ((reset ? '' : old) + value).slice(-65536));
    } finally { logPending.current = false; }
  }
  const logRead = useRef(readLog); useEffect(() => { logRead.current = readLog; });
  useFocusEffect(useCallback(() => { if (!follow) return; let running = false; const timer = setInterval(() => { if (!running) { running = true; void logRead.current().catch((failure: unknown) => setError(String(failure))).finally(() => { running = false; }); } }, 1500); return () => clearInterval(timer); }, [follow, setError]));
  function remove() {
    if (!selected) return;
    Alert.alert(t('Delete process record?'), t('Removes the exited record and retained logs.'), [{ text: t('Cancel') }, { text: t('Delete'), style: 'destructive', onPress: () => { void perform(async () => { await services!.processes.remove(selected.id); choose(undefined); setSelected(undefined); await refresh(); }); } }]);
  }
  return <ServiceFrame title={selected?.name ?? '后台进程'} c={c} palette={palette} error={error} working={working} back={back} headerBusy={false}>
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      {!!notice && <Text selectable style={[s.note, { color: c.accent }]}>{t(notice)}</Text>}
      {selected ? <>
        <View style={s.summary}>
          <Text style={[type.heading, { color: selected.state === 'running' ? c.accent : selected.state === 'failed' || selected.state === 'lost' ? c.danger : c.heading }]}>{t(processLabel[selected.state])}</Text>
          <Text style={[type.caption, { color: c.quiet }]}>{selected.identity === 'root' ? t('Root requested') : t('App identity')}</Text>
        </View>
        <Text selectable style={[type.mono, { color: c.text, marginTop: 4 }]}>{selected.id}</Text>
        <Text selectable style={[type.micro, { color: c.quiet }]}>{selected.definitionId}</Text>
        <View style={s.meta}>
          <MetaRow label="Supervisor PID" value={selected.pid == null ? '—' : String(selected.pid)} c={c} />
          <MetaRow label="Service PID" value={selected.payloadPid == null ? '—' : String(selected.payloadPid)} c={c} />
          <MetaRow label="UID" value={selected.observedUid == null ? '—' : String(selected.observedUid)} c={c} />
          <MetaRow label="Created" value={date(selected.createdAt)} c={c} />
          <MetaRow label="Started" value={date(selected.startedAt)} c={c} />
          <MetaRow label="Ended" value={date(selected.endedAt)} c={c} />
          <MetaRow label="Exit code" value={selected.exitCode == null ? '—' : String(selected.exitCode)} c={c} />
          <MetaRow label="Working directory" value={selected.cwd || 'Home'} c={c} />
        </View>
        {!!selected.reason && <Text selectable style={[s.note, { color: selected.state === 'failed' || selected.state === 'lost' ? c.danger : c.quiet }]}>{selected.reason}</Text>}
        {!!selected.ioError && <Text selectable style={[s.note, { color: c.danger }]}>{selected.ioError}</Text>}
        {!!selected.persistenceError && <Text selectable style={[s.note, { color: c.danger }]}>{t('Process registry persistence failed')} · {String(selected.persistenceError)}</Text>}
        {selected.processMaySurvive && <Text selectable style={[s.note, { color: c.danger }]}>{t('Ownership cannot be verified; the process may still be alive. It will not restart automatically.')}</Text>}
        {!!endpoints.length && <><Text style={[type.section, { color: c.heading, marginTop: 20 }]}>{t('Configured endpoints (unverified)')}</Text>{endpoints.map((endpoint) => <Text key={endpoint} selectable style={[type.mono, { color: c.text, marginTop: 4 }]}>{endpoint}</Text>)}</>}
        <Text selectable style={[s.codeBlock, { color: c.text, backgroundColor: c.code }]}>{selected.argv ? JSON.stringify(selected.argv, null, 2) : selected.script}</Text>
        <View>
          <Action label="Refresh status" icon="search" c={c} disabled={working} onPress={() => { void perform(refresh); }} />
          {(active || selected.state === 'lost') && <Action label="Stop process" icon="stop" danger c={c} testID="process-stop" disabled={working} onPress={() => { void perform(async () => { setSelected(await services!.processes.stop(selected.id)); await refresh(); }); }} />}
          {['exited', 'failed'].includes(selected.state) && !selected.processMaySurvive && !protocol && <Action label="Start another instance" icon="terminal" c={c} testID="process-repeat" disabled={working} onPress={() => { void perform(async () => { const next = await services!.processes.start(`ui-${globalThis.crypto.randomUUID()}`, { definitionId: selected.definitionId }); choose(next.id); setSelected(next); await refresh(); }); }} />}
          {['exited', 'failed'].includes(selected.state) && !selected.processMaySurvive && <Action label="Delete record" icon="trash" danger c={c} disabled={working} onPress={remove} />}
        </View>
        {linked.map((mcp) => <View key={mcp.id}><Action label={`MCP · ${mcp.name}`} icon="grid" c={c} onPress={() => router.push({ pathname: '/mcp', params: { id: mcp.id } })} />{mcp.url && <Text selectable style={[s.metaNote, { color: c.quiet }]}>{mcp.connection?.state === 'connected' ? t('Connected through MCP protocol') : t('MCP endpoint not verified')}{'\n'}{mcp.url}</Text>}</View>)}
        {protocol && <Text style={[s.metaNote, { color: c.quiet }]}>{t('MCP owns stdin and stdout. Only diagnostic logs are shown here; disabling MCP preserves the process.')}</Text>}
        <Text style={[type.section, { color: c.heading, marginTop: 24 }]}>{t('Process logs')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.inlineScroll} contentContainerStyle={s.inlineActions}>
          {(!protocol ? ['stdout', 'stderr'] as const : ['stderr'] as const).map((name) => <TextAction key={name} label={name} c={c} active={stream === name} onPress={() => logStream(name)} />)}
          <TextAction label={logLoaded ? '读取后续日志' : '读取日志'} c={c} disabled={working || follow} onPress={() => { void perform(() => readLog()); }} />
          <TextAction label="Read from earliest retained byte" c={c} disabled={working || follow} onPress={() => { void perform(() => readLog(true)); }} />
          <TextAction label={follow ? '停止跟随日志' : '跟随日志'} c={c} active={follow} onPress={() => setFollow(!follow)} />
        </ScrollView>
        {!!logPage && <Text style={[s.metaNote, { color: c.quiet }]}>{t('Byte position')} {logPage.cursor} → {logPage.nextCursor} / {logPage.totalBytes}{'\n'}{t('Dropped bytes')} {logPage.droppedBytes} · {t('Caught up')} {logPage.complete ? t('Yes') : t('No')}{'\n'}{t('The view retains the latest 65,536 characters.')}</Text>}
        <Text selectable testID="process-log" style={[s.codeBlock, { color: c.text, backgroundColor: c.code }]}>{rawLog && logPage ? logPage.base64 : log || t(logLoaded ? 'No new output' : 'Logs load on demand')}</Text>
        {logPage && <TextAction label={rawLog ? '显示 UTF-8 文本' : '显示本页 Base64'} c={c} onPress={() => setRawLog(!rawLog)} />}
        {!protocol && selected.state === 'running' && <>
          <Field label="Send to stdin" value={input} onChange={setInput} c={c} disabled={working} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.inlineScroll} contentContainerStyle={s.inlineActions}>
            <TextAction label={newline ? '追加换行：是' : '追加换行：否'} c={c} active={newline} onPress={() => setNewline(!newline)} />
            <TextAction label="Send input" c={c} disabled={working || !input} onPress={() => { void perform(async () => { await services!.processes.write(selected.id, input + (newline ? '\n' : '')); setInput(''); setNotice(t('Input submitted; command completion is not implied.')); }); }} />
            <TextAction label="Close stdin" c={c} disabled={working} onPress={() => { void perform(async () => { await services!.processes.write(selected.id, '', true); setNotice(t('Stdin closed')); }); }} />
          </ScrollView>
        </>}
      </> : <>
        <View style={s.listHead}>{!loading && <Text style={[type.caption, { color: c.quiet }]}>{records.length ? t('{count} processes', { count: records.length }) : t('No background processes yet')}</Text>}<RefreshBars left={left} c={c} /></View>
        {loading && <BusyIndicator color={c.accent} />}
        {records.map((record) => <Pressable key={record.id} accessibilityRole="button" accessibilityLabel={`${t('View process')} ${record.name}`} onPress={() => { choose(record.id); setStream(record.protocolOwner ? 'stderr' : 'stdout'); setSelected(record); setNotice(''); }} style={({ pressed }) => [s.processRow, pressed && { backgroundColor: c.wash }]}><Icon name="terminal" color={record.state === 'running' ? c.accent : c.quiet} /><View style={s.processText}><Text numberOfLines={1} style={[type.body, { color: c.heading }]}>{record.name}</Text><Text style={[type.caption, { color: record.state === 'failed' || record.state === 'lost' ? c.danger : c.quiet }]}>{t(processLabel[record.state])} · {record.identity === 'root' ? 'root' : 'App'} · {date(record.createdAt)}</Text>{!!record.reason && <Text numberOfLines={2} style={[type.caption, { color: c.quiet }]}>{record.reason}</Text>}</View></Pressable>)}
      </>}
    </ScrollView>
  </ServiceFrame>;
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  note: { ...type.caption, marginVertical: 8 },
  summary: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 },
  meta: { marginTop: 12 }, metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, minHeight: 30, paddingVertical: 3 },
  codeBlock: { ...type.code, marginHorizontal: -20, marginTop: 16, paddingHorizontal: 20, paddingVertical: 14 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, marginHorizontal: -20, paddingHorizontal: 20 },
  textAction: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 40, paddingRight: 4 },
  inlineScroll: { flexGrow: 0, marginHorizontal: -20, marginTop: 4 }, inlineActions: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 20 },
  metaNote: { ...type.caption, marginTop: 6, marginBottom: 4 },
  field: { gap: 7, marginTop: 18 }, input: { ...type.code, minHeight: 88, padding: 12, textAlignVertical: 'top' },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 },
  processRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, marginHorizontal: -20, paddingHorizontal: 20, paddingVertical: 8 },
  processText: { flex: 1, gap: 3 },
});
