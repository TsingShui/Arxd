import * as DocumentPicker from 'expo-document-picker';
import { MAX_LOCAL_MODEL_BYTES, PINNED_MODEL_ID, type LocalStatus } from '../agent/local-provider';
import { BusyIndicator } from './BusyIndicator';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Model, Api, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { useI18n } from '../i18n';
import { getAndroidWorkspace } from '../workspace/android';
import type { Workspace, WorkspaceSnapshot } from '../workspace/core';
import { ACCOUNT_PRESETS, modelCapabilities, PRESETS, PROTOCOLS, type ConfiguredModel, type ConnectionAuth, type ConnectionView, type Generation, type Preset, type Protocol } from '../workspace/connections';
import { piAccounts, type PiAccountProvider } from '../workspace/pi-account';
import { contextLabel } from '../workspace/models';
import { BrandIcon, type BrandName } from './BrandIcon';
import { Icon, type IconName } from './Icon';
import { useTheme } from './appearance';
import { type Colors } from './theme';
import { type } from './type';

function useConfiguration() {
  const [core, setCore] = useState<Workspace>(); const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [rows, setRows] = useState<ConnectionView[]>([]); const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [working, setWorking] = useState(false); const [error, setError] = useState(''); const locked = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((workspace) => { if (alive.current) { setCore(workspace); setSnapshot(workspace.getSnapshot()); unsubscribe = workspace.subscribe(setSnapshot); } }).catch((error) => { if (alive.current) setError(String(error)); });
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);
  const refresh = useCallback(async () => { if (core) { const list = await core.connections.list(); if (alive.current) { setRows(list); setModels(core.connections.models()); } } }, [core]);
  const clearError = useCallback(() => setError(''), []);
  useFocusEffect(useCallback(() => { void refresh().catch((error) => { if (alive.current) setError(String(error)); }); }, [refresh]));
  async function run<T>(action: (core: Workspace) => Promise<T>): Promise<T | undefined> {
    if (!core || locked.current) return undefined; locked.current = true; setWorking(true); setError('');
    try { const result = await action(core); await refresh(); return result; } catch (error) { if (alive.current) setError(String(error).replace(/^Error: /, '').slice(0, 1000)); return undefined; }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  /** Refresh remote catalog data without blocking or changing the visible busy state. */
  async function background<T>(action: (core: Workspace) => Promise<T>): Promise<T | undefined> {
    if (!core) return undefined;
    try { const result = await action(core); await refresh(); return result; } catch { return undefined; }
  }
  return { core, snapshot, rows, models, working, busy: working || !core || !!snapshot?.conversations.some((row) => row.busy), error, clearError, c: useTheme().c, run, background };
}
type Configuration = ReturnType<typeof useConfiguration>;
function Frame({ title, data, children, right, overlay, busy }: { title: string; data: Configuration; children: ReactNode; right?: ReactNode; overlay?: ReactNode; busy?: boolean }) {
  const { t } = useI18n(); const { c } = data; const { reducedMotion } = useTheme(); const { error, clearError } = data;
  const [opacity] = useState(() => new Animated.Value(0)); const [lift] = useState(() => new Animated.Value(-4));
  const dismiss = useCallback(() => {
    if (!error) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: reducedMotion ? 0 : 140, useNativeDriver: true }),
      Animated.timing(lift, { toValue: -4, duration: reducedMotion ? 0 : 140, useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) clearError(); });
  }, [clearError, error, lift, opacity, reducedMotion]);
  useEffect(() => {
    if (!error) return;
    opacity.setValue(0); lift.setValue(-4);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: reducedMotion ? 0 : 160, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: reducedMotion ? 0 : 160, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(dismiss, 3200);
    return () => clearTimeout(timer);
  }, [error, dismiss, lift, opacity, reducedMotion]);
  return <KeyboardAvoidingView behavior="height" style={s.screen}><SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}><View style={s.headerWrap}><View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={t('Back')} testID="models-back" onPress={() => router.back()} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable><Text numberOfLines={1} style={[type.heading, { flex: 1, color: c.heading }]}>{t(title)}</Text>{right}{(busy ?? data.working) && <BusyIndicator color={c.accent} />}</View>{!!error && <Animated.View style={[s.errorNotice, { backgroundColor: c.wash, opacity, transform: [{ translateY: lift }] }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={dismiss} style={s.errorClose}><Icon name="close" color={c.danger} size={16} /></Pressable></Animated.View>}</View><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>{children}</ScrollView>{overlay}</SafeAreaView></KeyboardAvoidingView>;
}
const ACCOUNT_COPY: Record<PiAccountProvider, { title: string }> = {
  'openai-codex': { title: 'OpenAI Codex' },
  'kimi-coding': { title: 'Kimi Code' },
  xai: { title: 'xAI Grok' },
};
const ACCOUNT_BRAND: Record<PiAccountProvider, BrandName> = { 'openai-codex': 'openai', 'kimi-coding': 'kimi', xai: 'xai' };
const PRESET_BRAND: Partial<Record<Preset, BrandName>> = { deepseek: 'deepseek', openai: 'openai', anthropic: 'anthropic', google: 'gemini', 'openai-codex': 'openai', 'kimi-coding': 'kimi', xai: 'xai' };
function connectionState(row: ConnectionView, t: (value: string) => string): string {
  if (row.status === 'deleting') return t('Deletion needs retry');
  if (row.credentialError) return t('Credential error');
  if (row.auth === 'account') return t(row.hasCredential ? 'Signed in' : 'Not signed in');
  if (row.auth === 'none') return t('No authentication (2)');
  return t(row.hasCredential ? 'Configured' : 'Not configured');
}
function LoginLayer({ visible, title, c, close, children }: { visible: boolean; title: string; c: Colors; close: () => void; children: ReactNode }) {
  const { t } = useI18n();
  return <Modal visible={visible} animationType="fade" onRequestClose={close} statusBarTranslucent>
    <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
      <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={close} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable><Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{title}</Text></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>{children}</ScrollView>
    </SafeAreaView>
  </Modal>;
}

function ConnectionTab({ label, count, selected, c, action }: { label: string; count: number; selected: boolean; c: Colors; action: () => void }) {
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={action} style={({ pressed }) => [s.listTab, pressed && { opacity: .55 }]}>
    <Text style={[type.list, { color: selected ? c.accent : c.quiet }]}>{label}</Text>
    <Text style={[type.micro, { color: selected ? c.accent : c.faint }]}>{count}</Text>
  </Pressable>;
}

function ConnectionRow({ row, count, c }: { row: ConnectionView; count: number; c: Colors }) {
  const { t } = useI18n();
  const state = connectionState(row, t);
  const stateColor = row.credentialError ? c.danger : row.status === 'deleting' ? c.warning : row.hasCredential || row.auth === 'none' ? c.contextMedium : c.quiet;
  const initial = row.name.trim().charAt(0).toUpperCase() || '·';
  const brand = PRESET_BRAND[row.preset];
  return <Pressable accessibilityRole="button" accessibilityLabel={row.name} onPress={() => router.push({ pathname: '/models/connection', params: { id: row.id } })} style={({ pressed }) => [s.listRow, pressed && { backgroundColor: c.wash }, row.status !== 'active' && { opacity: .55 }]}>
    <View style={s.rowBrand}>{brand ? <BrandIcon name={brand} color={c.accent} size={20} /> : <Text style={[s.rowInitial, { color: c.accent }]}>{initial}</Text>}</View>
    <View style={s.rowMain}><Text numberOfLines={1} style={[s.rowTitle, { color: c.heading }]}>{row.name}<Text style={[type.micro, { color: c.quiet }]}> · {t('{count} models', { count })}</Text></Text></View>
    <Text style={[type.micro, { color: stateColor }]}>{state}</Text>
  </Pressable>;
}

function AccountRow({ preset, row, count, c, action }: { preset: typeof ACCOUNT_PRESETS[number]; row?: ConnectionView; count: number; c: Colors; action: () => void }) {
  const { t } = useI18n();
  const state = row ? connectionState(row, t) : t('Not signed in');
  const stateColor = row?.credentialError ? c.danger : row?.hasCredential ? c.contextMedium : c.quiet;
  return <Pressable accessibilityRole="button" accessibilityLabel={t('Sign in to {name}', { name: ACCOUNT_COPY[preset.account].title })} onPress={action} style={({ pressed }) => [s.listRow, pressed && { backgroundColor: c.wash }, row && row.status !== 'active' && { opacity: .55 }]}>
    <View style={s.rowBrand}><BrandIcon name={ACCOUNT_BRAND[preset.account]} color={c.accent} size={20} /></View>
    <View style={s.rowMain}><Text numberOfLines={1} style={[s.rowTitle, { color: c.heading }]}>{ACCOUNT_COPY[preset.account].title}{!!row && <Text style={[type.micro, { color: c.quiet }]}> · {t('{count} models', { count })}</Text>}</Text></View>
    <Text style={[type.micro, { color: stateColor }]}>{state}</Text>
  </Pressable>;
}

function modelSize(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function LocalModelControls({ data }: { data: Configuration }) {
  const { t } = useI18n(); const { c, core } = data;
  const [status, setStatus] = useState<LocalStatus>();
  useEffect(() => {
    const poll = () => { if (core?.localModel) setStatus(core.localModel.status()); };
    poll(); const timer = setInterval(poll, 750); return () => clearInterval(timer);
  }, [core]);
  if (!core?.localModel || !status) return null;
  const busy = data.busy || status.busy || status.operation !== 'idle';
  const downloading = status.operation === 'downloading';
  const models = status.models;
  const pinned = models.find((model) => model.id === PINNED_MODEL_ID);
  async function pick() {
    const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    if (picked.canceled) return undefined;
    const asset = picked.assets[0];
    if (!asset.name.toLowerCase().endsWith('.gguf')) throw new Error(t('Choose a GGUF model file'));
    if (asset.size !== undefined && asset.size > MAX_LOCAL_MODEL_BYTES) throw new Error(t('On-device model exceeds the 8 GiB limit'));
    return { uri: asset.uri, name: asset.name };
  }
  return <View>
    {models.map((model) => {
      const active = data.snapshot?.model === model.id;
      return <View key={model.id} style={s.localModel}>
        <View style={s.localModelRow}>
          <View style={s.localModelMain}>
            <Text numberOfLines={1} style={[s.modelName, { color: c.heading }]}>{model.name}</Text>
            <Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{modelSize(model.bytes)} · {contextLabel(model.contextWindow)} · off · {model.sha256.slice(0, 8)}</Text>
          </View>
          <Pressable accessibilityRole="checkbox" accessibilityLabel={t(active ? 'Currently using {name}' : 'Use {name}', { name: model.name })} accessibilityState={{ checked: active, disabled: busy || !model.available }} disabled={busy || !model.available} onPress={() => { void data.run(async (workspace) => { await workspace.model(model.id); }); }} style={({ pressed }) => [s.connectionModelCheck, pressed && { opacity: .55 }, (busy || !model.available) && { opacity: .35 }]}>
            <View style={[s.modelCheck, { backgroundColor: active ? c.accent : c.raised }]}>{active && <Icon name="check" color={c.onAccent} size={14} />}</View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Delete {name}', { name: model.name })} disabled={busy} onPress={() => Alert.alert(t('Delete on-device model'), t('Conversations and analysis files stay. Download or import again to use it.'), [{ text: t('Cancel'), style: 'cancel' }, { text: t('Delete'), style: 'destructive', onPress: () => { void data.run((workspace) => workspace.localModel!.remove(model.id)); } }])} style={({ pressed }) => [s.connectionModelCheck, pressed && { opacity: .55 }, busy && { opacity: .35 }]}>
            <Icon name="trash" color={c.danger} size={18} />
          </Pressable>
        </View>
      </View>;
    })}
    {status.operation === 'importing' && <ActionRow icon="close" label="Cancel import" c={c} action={() => core.localModel?.cancelDownload()} />}
    {status.operation === 'removing' && <Text style={[type.caption, { color: c.quiet, paddingVertical: 14 }]}>{t('Deleting')}</Text>}
    {status.operation === 'verifying' && <Text style={[type.caption, { color: c.quiet, paddingVertical: 14 }]}>{t('Verifying')}</Text>}
    {status.operation === 'idle' && <ActionRow icon="upload" label="Import GGUF" c={c} disabled={busy} action={() => { void data.run(async (workspace) => { const asset = await pick(); if (asset) await workspace.localModel!.import(asset.uri, asset.name); }); }} />}
    {!pinned && downloading && <><Text style={[type.caption, { color: c.quiet, paddingVertical: 14 }]}>{status.totalBytes ? `${Math.floor(status.bytes / status.totalBytes * 100)}%` : t('Downloading')}</Text><ActionRow icon="close" label="Cancel download" c={c} action={() => core.localModel?.cancelDownload()} /></>}
    {!pinned && status.operation === 'idle' && <ActionRow icon="download" label="Download Qwen3.5-2B" c={c} disabled={busy} action={() => { void data.run((workspace) => workspace.localModel!.download()); }} />}
    <ActionRow icon="folder" label="Open in files" c={c} disabled={false} action={() => router.push({ pathname: '/files', params: { root: 'models' } })} />
  </View>;
}

export function ConnectionsScreen() {
  const { t } = useI18n(); const data = useConfiguration(); const { c } = data;
  const params = useLocalSearchParams<{ add?: string; local?: string }>();
  const [tab, setTab] = useState<'api' | 'account' | 'local'>(params.local === '1' ? 'local' : params.add === '1' ? 'account' : 'api');
  const [login, setLogin] = useState<{ provider: PiAccountProvider; title: string; busy: boolean; code?: string; url?: string; instructions?: string }>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const connected = (row: ConnectionView) => row.status === 'active' && (row.auth === 'none' || row.hasCredential);
  const connectedConnections = new Set(data.rows.filter(connected).map((row) => row.id));
  const activeModelList = data.models.filter((model) => connectedConnections.has(model.connectionId));
  const choices = activeModelList.filter((model) => model.enabled);
  const apiRows = data.rows.filter((row) => row.auth !== 'account');
  const connectedApi = apiRows.filter(connected);
  const connectedAccounts = ACCOUNT_PRESETS.map((preset) => data.rows.find((row) => row.preset === preset.id && row.auth === 'account')).filter((row): row is ConnectionView => !!row && connected(row));
  const modelCount = (connectionId?: string) => connectionId ? data.models.filter((model) => model.connectionId === connectionId).length : 0;
  function begin(provider: PiAccountProvider) {
    if (!data.core || data.busy || controller.current) return;
    setTab('account');
    const abort = new AbortController(); controller.current = abort;
    setLogin({ provider, title: ACCOUNT_COPY[provider].title, busy: true });
    void data.run(async (core) => {
      const result = await core.connections.loginAccount(provider, (event) => {
        if (event.type === 'device-code') {
          setLogin((current) => current ? { ...current, busy: true, code: event.userCode, url: event.verificationUri, instructions: event.instructions } : current);
          void Linking.openURL(event.verificationUri).catch(() => undefined);
        } else if (event.type === 'auth-url') {
          setLogin((current) => current ? { ...current, busy: true, url: event.url, instructions: event.instructions } : current);
          void Linking.openURL(event.url).catch(() => undefined);
        } else if (event.type === 'progress') {
          setLogin((current) => current ? { ...current, instructions: event.message } : current);
        }
      }, abort.signal);
      if (result) { setLogin(undefined); router.push({ pathname: '/models/connection', params: { id: result.id } }); }
      else setLogin((current) => current ? { ...current, busy: false } : current);
      return result;
    }).finally(() => { controller.current = undefined; });
  }
  function cancel() { if (login) piAccounts().cancel(login.provider); controller.current?.abort(); controller.current = undefined; setLogin(undefined); }
  function choose(preset: typeof ACCOUNT_PRESETS[number]) {
    const row = data.rows.find((item) => item.preset === preset.id && item.auth === 'account');
    if (row?.hasCredential) router.push({ pathname: '/models/connection', params: { id: row.id } });
    else begin(preset.account);
  }
  return <>
    <Frame title={t('Models')} data={data}>
      <View style={s.connectionPage}>
        {choices.length > 0 && <>
          <Text style={[s.sectionLabel, { color: c.faint }]}>{t('Enabled')}</Text>
          {choices.map((choice) => <View key={choice.id} style={s.modelLine}><Text style={[s.modelName, { color: c.text }]}>{choice.definition.name}</Text><Text style={[type.micro, { color: c.quiet }]}>{contextLabel(choice.definition.contextWindow)}</Text></View>)}
        </>}
        <View style={s.listTabs} accessibilityRole="tablist">
          <ConnectionTab label={t('API')} count={connectedApi.length} selected={tab === 'api'} c={c} action={() => setTab('api')} />
          <ConnectionTab label={t('Accounts')} count={connectedAccounts.length} selected={tab === 'account'} c={c} action={() => setTab('account')} />
          <ConnectionTab label={t('Local models')} count={data.core?.localModel?.status().models.length ?? 0} selected={tab === 'local'} c={c} action={() => setTab('local')} />
        </View>
        {tab === 'local' ? <LocalModelControls data={data} /> : tab === 'api' ? <>
          {apiRows.map((row) => <ConnectionRow key={row.id} row={row} count={modelCount(row.id)} c={c} />)}
          <Pressable testID="add-api-connection" accessibilityRole="button" accessibilityLabel={t('Add API connection')} onPress={() => router.push('/models/edit')} style={({ pressed }) => [s.listRow, s.addRow, pressed && { backgroundColor: c.wash }]}>
            <Icon name="plus" color={c.accent} size={18} /><Text style={[s.rowTitle, { color: c.text }]}>{t('Add API connection')}</Text>
          </Pressable>
        </> : ACCOUNT_PRESETS.map((preset) => {
          const row = data.rows.find((item) => item.preset === preset.id && item.auth === 'account');
          return <AccountRow key={preset.id} preset={preset} row={row} count={modelCount(row?.id)} c={c} action={() => choose(preset)} />;
        })}
      </View>
    </Frame>
    <LoginLayer visible={!!login} title={t('Accounts')} c={c} close={cancel}>
      {login && <>
        <View style={s.loginIdentity}><BrandIcon name={ACCOUNT_BRAND[login.provider]} color={c.accent} size={22} /><Text style={[type.heading, { color: c.heading }]}>{login.title}</Text></View>
        {login.busy && <View style={s.loginBusy}><BusyIndicator color={c.accent} /><Text style={[type.caption, { color: c.quiet }]}>{t('Waiting for account authorization…')}</Text></View>}
        {!!login.code && <><Text style={[type.caption, { color: c.quiet, marginTop: 18 }]}>{t('Enter the code in your browser')}</Text><Text selectable style={[s.loginCode, { color: c.accent }]}>{login.code}</Text></>}
        {!!login.url && <Pressable accessibilityRole="button" accessibilityLabel={t('Open sign-in page')} onPress={() => { void Linking.openURL(login.url!).catch(() => undefined); }} style={({ pressed }) => [s.loginPrimary, { backgroundColor: c.accent }, pressed && { opacity: .82 }]}><Text style={[type.label, { color: c.onAccent }]}>{t('Open sign-in page')}</Text></Pressable>}
        {!!login.instructions && <Text style={[type.micro, { color: c.quiet, lineHeight: 18, marginTop: 12 }]}>{login.instructions}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={t('Cancel sign-in')} onPress={cancel} style={({ pressed }) => [s.loginCancel, pressed && { opacity: .55 }]}><Text style={[type.label, { color: c.quiet }]}>{t('Cancel sign-in')}</Text></Pressable>
      </>}
    </LoginLayer>
  </>;
}

function ActionRow({ icon, label, action, c, disabled = false, danger = false }: { icon: IconName; label: string; action: () => void; c: Colors; disabled?: boolean; danger?: boolean }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} disabled={disabled} onPress={action} style={({ pressed }) => [s.connectionAction, pressed && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}>
    <Icon name={icon} size={18} color={danger ? c.danger : c.quiet} />
    <Text style={[type.list, { color: danger ? c.danger : c.text }]}>{t(label)}</Text>
  </Pressable>;
}

export function ConnectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); const data = useConfiguration(); const { t } = useI18n(); const { c } = data;
  const insets = useSafeAreaInsets();
  const row = data.rows.find((row) => row.id === id); const models = data.models.filter((model) => model.connectionId === id);
  const [result, setResult] = useState<string>(); const [backgroundBusy, setBackgroundBusy] = useState(false); const auto = useRef(new Set<string>()); const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { if (!result) return; const timer = setTimeout(() => setResult(undefined), 3200); return () => clearTimeout(timer); }, [result]);
  const canDiscover = !!row && row.status === 'active' && row.auth !== 'account' && (row.auth !== 'key' || row.hasCredential);
  useEffect(() => {
    if (!row || !canDiscover || auto.current.has(row.id)) return;
    auto.current.add(row.id);
    setBackgroundBusy(true);
    void data.background(async (core) => { await core.connections.discoverModels(row.id); }).finally(() => {
      if (mounted.current) setBackgroundBusy(false);
    });
  }, [row, canDiscover, data]);
  function logout() { if (!row) return; Alert.alert(t('Sign out of {name}?', { name: row.name }), t('Messages and model configuration stay. Sign in again before using this account.'), [{ text: t('Cancel') }, { text: t('Sign out'), style: 'destructive', onPress: () => { void data.run(async (core) => { await core.connections.logoutAccount(row.id); }); } }]); }
  function remove() { if (!row) return; Alert.alert(t('Remove connection {name}?', { name: row.name }), t('Remove this connection and its device credentials and disable its models. Conversations, attachments and replies stay.'), [{ text: t('Cancel') }, { text: t('Remove'), style: 'destructive', onPress: () => { void data.run(async (core) => { await core.connections.remove(id); router.back(); }); } }]); }
  const auth = row?.credentialError ? t('Credential error') : row?.auth === 'account' ? t(row.hasCredential ? 'Account signed in' : 'Account not signed in') : row?.auth === 'none' ? t('No authentication (2)') : t(row?.hasCredential ? 'Credential saved' : 'Credential missing');
  return <Frame title={row?.name ?? t('Connection details')} data={data} busy={data.working && !backgroundBusy} right={canDiscover ? <Pressable accessibilityRole="button" accessibilityLabel={t('Refresh models')} testID="discover-models" disabled={data.busy || backgroundBusy} onPress={() => { setBackgroundBusy(true); void data.run(async (core) => { const result = await core.connections.discoverModels(row.id); setResult(t('Found {total} models; added {added}', { total: result.discovered, added: result.added })); }).finally(() => { if (mounted.current) setBackgroundBusy(false); }); }} style={({ pressed }) => [s.headerIcon, pressed && { opacity: .55 }, (data.busy || backgroundBusy) && { opacity: .35 }]}>{backgroundBusy ? <BusyIndicator color={c.accent} size="small" /> : <Icon name="refresh" size={18} color={c.quiet} />}</Pressable> : undefined} overlay={!!result && !data.error ? <View pointerEvents="none" style={[s.connectionToast, { bottom: insets.bottom + 18, backgroundColor: c.surface }]}><Text numberOfLines={3} style={[type.caption, { color: c.text }]}>{result}</Text></View> : undefined}>{row && <>
    <View style={s.connectionMeta}>
      <Text selectable style={[s.connectionMetaLine, { color: c.quiet }]}>{row.protocol}</Text>
      <Text selectable style={[s.connectionMetaLine, { color: c.quiet }]}>{row.endpoint}</Text>
      <Text style={[s.connectionMetaLine, { color: row.credentialError ? c.danger : c.quiet }]}>{auth}</Text>
    </View>

    <ActionRow icon="edit" label="Edit" c={c} disabled={data.busy || row.status !== 'active'} action={() => router.push({ pathname: '/models/edit', params: { id } })} />
    {row.auth === 'account' && (row.hasCredential ? <ActionRow icon="power" label="Sign out (2)" c={c} disabled={data.busy} action={logout} /> : <ActionRow icon="user" label="Sign in" c={c} disabled={data.busy} action={() => router.replace({ pathname: '/models', params: { add: '1' } })} />)}
    <ActionRow icon="plus" label="Add model manually" c={c} disabled={data.busy || row.status !== 'active'} action={() => router.push({ pathname: '/models/model', params: { id } })} />
    <ActionRow icon="trash" label={row.status === 'deleting' ? '重试移除' : '移除'} c={c} danger disabled={data.busy} action={remove} />

    <Text style={[s.groupLabel, { color: c.faint }]}>{t('Model')}</Text>

    {!models.length && <Text style={[type.caption, { color: c.quiet, paddingVertical: 14 }]}>{t('No models for this connection yet')}</Text>}
    {models.map((model) => {
      const disabled = data.busy || row.status !== 'active';
      return <View key={model.id} style={s.connectionModel}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Edit model {name}', { name: model.definition.name })} onPress={() => router.push({ pathname: '/models/model', params: { id, model: model.id } })} style={({ pressed }) => [s.connectionModelMain, pressed && { opacity: .55 }]}>
          <Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{model.definition.name}</Text>
          <Text numberOfLines={1} style={[type.micro, { color: c.quiet }]}>{model.definition.id} · {contextLabel(model.definition.contextWindow)} · {t(model.enabled ? 'Enabled' : 'Disabled')}</Text>
        </Pressable>
        <Pressable accessibilityRole="checkbox" accessibilityLabel={t(model.enabled ? 'Disable {name}' : 'Enable {name}', { name: model.definition.name })} accessibilityState={{ checked: model.enabled, disabled }} disabled={disabled} onPress={() => { void data.run(async (core) => { await core.connections.updateModel(model.id, model.generation, !model.enabled); }); }} style={({ pressed }) => [s.connectionModelCheck, pressed && { opacity: .55 }, disabled && { opacity: .35 }]}>
          <View style={[s.modelCheck, { backgroundColor: model.enabled ? c.accent : c.raised }]}>{model.enabled && <Icon name="check" color={c.onAccent} size={14} />}</View>
        </Pressable>
      </View>;
    })}
  </>}</Frame>;
}

function EditorField({ title, value, change, c, secret = false, multiline = false, editable = true, numeric = false, placeholder = '' }: { title: string; value: string; change: (text: string) => void; c: Colors; secret?: boolean; multiline?: boolean; editable?: boolean; numeric?: boolean; placeholder?: string }) {
  const { t } = useI18n();
  return <View style={s.editorField}>
    <Text style={[type.caption, { color: c.quiet }]}>{t(title)}</Text>
    <TextInput accessibilityLabel={t(title)} value={value} onChangeText={change} secureTextEntry={secret} multiline={multiline} editable={editable} keyboardType={numeric ? 'decimal-pad' : 'default'} autoCorrect={false} autoCapitalize="none" maxLength={multiline ? 32768 : 4096} placeholder={placeholder} placeholderTextColor={c.faint} style={[s.editorInput, multiline && s.editorMultiline, { color: c.text, backgroundColor: c.code, opacity: editable ? 1 : .55 }]} />
  </View>;
}

function OptionStrip({ values, selected, onSelect, c, disabled = false, disabledValues = [] }: { values: readonly string[]; selected: string; onSelect: (value: string) => void; c: Colors; disabled?: boolean; disabledValues?: readonly string[] }) {
  const { t } = useI18n();
  return <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={s.optionStrip}>
    {values.map((value) => {
      const active = value === selected, blocked = disabled || disabledValues.includes(value);
      return <Pressable key={value} accessibilityRole="radio" accessibilityLabel={t(value)} accessibilityState={{ selected: active, disabled: blocked }} disabled={blocked} onPress={() => onSelect(value)} style={({ pressed }) => [s.optionItem, pressed && { opacity: .55 }, blocked && !active && { opacity: .35 }]}>
        <Text style={[s.optionText, { color: active ? c.accent : blocked ? c.faint : c.text }]}>{t(value)}</Text>
        {active && <Icon name="check" size={14} color={c.accent} />}
      </Pressable>;
    })}
  </ScrollView>;
}

function MultiOptionStrip({ values, selected, onToggle, c, disabled = false }: { values: readonly string[]; selected: readonly string[]; onToggle: (value: string) => void; c: Colors; disabled?: boolean }) {
  const { t } = useI18n();
  return <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={s.optionStrip}>
    {values.map((value) => {
      const active = selected.includes(value);
      return <Pressable key={value} accessibilityRole="checkbox" accessibilityLabel={t(value)} accessibilityState={{ checked: active, disabled }} disabled={disabled} onPress={() => onToggle(value)} style={({ pressed }) => [s.optionItem, pressed && { opacity: .55 }, disabled && { opacity: .35 }]}>
        <Text style={[s.optionText, { color: active ? c.accent : disabled ? c.faint : c.text }]}>{t(value)}</Text>
        {active && <Icon name="check" size={14} color={c.accent} />}
      </Pressable>;
    })}
  </ScrollView>;
}

export function ConnectionEditor() {
  const { id } = useLocalSearchParams<{ id?: string }>(); const data = useConfiguration(); const { t } = useI18n(); const { c } = data; const old = data.rows.find((row) => row.id === id);
  const [label, setLabel] = useState(''); const [preset, setPreset] = useState<Preset>('deepseek'); const [protocol, setProtocol] = useState<Protocol>('openai-completions'); const [url, setUrl] = useState('https://api.deepseek.com'); const [auth, setAuth] = useState<ConnectionAuth>('key');
  const [key, setKey] = useState(''); const [headers, setHeaders] = useState(''); const [showHeaders, setShowHeaders] = useState(false); const initialized = useRef(false);
  useEffect(() => { if (old && !initialized.current) { initialized.current = true; setLabel(old.name); setPreset(old.preset); setProtocol(old.protocol); setUrl(old.endpoint); setAuth(old.auth); } }, [old]);
  function clearCredential() {
    if (!id) return;
    Alert.alert(t('Clear device credential?'), t('Past messages remain. Configure a credential before using this connection again.'), [{ text: t('Cancel') }, { text: t('Clear'), style: 'destructive', onPress: () => { void data.run(async (core) => { await core.connections.credential(id, null); router.back(); }); } }]);
  }
  const saveDisabled = data.busy || !!id && !old;
  return <Frame title={t(id ? 'Edit' : 'Add connection')} data={data}>
    {!id && <>
      <Text style={[s.editorLabel, { color: c.quiet }]}>{t('Preset')}</Text>
      <OptionStrip values={PRESETS.filter((item) => !('account' in item)).map((item) => item.name)} selected={PRESETS.find((item) => item.id === preset)?.name ?? ''} c={c} disabled={data.busy} onSelect={(value) => { const item = PRESETS.find((entry) => entry.name === value); if (!item) return; setPreset(item.id); setProtocol(item.protocol); setUrl(item.endpoint); setLabel(item.id === 'custom' ? '' : item.name); }} />
    </>}
    <EditorField title="Connection name" value={label} change={setLabel} c={c} editable={!data.busy} placeholder={t('For example: work account')} />
    {old?.auth === 'account' ? <Text style={[type.caption, { color: c.quiet }]}>{t('Manage account sign-in in connection details. Only the connection name is edited here.')}</Text> : <>
      <Text style={[s.editorLabel, { color: c.quiet }]}>{t('Protocol')}</Text>
      <OptionStrip values={PROTOCOLS} selected={protocol} c={c} disabled={data.busy || !!id && data.models.some((model) => model.connectionId === id)} onSelect={(value) => { const next = value as Protocol; setProtocol(next); if (next === 'google-generative-ai') setAuth('key'); }} />
      <EditorField title="Endpoint" value={url} change={setUrl} c={c} editable={!data.busy} placeholder="https://example.com/v1" />
      {url.startsWith('http:') && <Text style={[type.caption, { color: c.warning }]}>{t('HTTP is unencrypted. Check the address of your local service.')}</Text>}
      <Text style={[s.editorLabel, { color: c.quiet }]}>{t('Authentication (2)')}</Text>
      <OptionStrip values={['API Key / 请求头', '无需认证']} selected={auth === 'key' ? 'API Key / 请求头' : '无需认证'} disabledValues={protocol === 'google-generative-ai' ? ['无需认证'] : []} c={c} disabled={data.busy} onSelect={(value) => setAuth(value === '无需认证' ? 'none' : 'key')} />
      {auth === 'key' && <>
        <EditorField title="API Key" value={key} change={setKey} secret c={c} editable={!data.busy} placeholder={t(old?.credentialError ? 'Credential unreadable; enter a new API Key' : old?.hasCredential ? '************' : 'Enter API Key')} />
        <ActionRow icon="sliders" label={showHeaders ? '收起高级请求头' : '高级请求头'} c={c} action={() => setShowHeaders(!showHeaders)} />
        {showHeaders && <EditorField title="Headers JSON" value={headers} change={setHeaders} multiline c={c} editable={!data.busy} placeholder={'{"X-API-Key":"…"}'} />}
        {!!id && (old?.hasCredential || old?.credentialError) && <ActionRow icon="trash" label="Clear device credential" c={c} danger disabled={data.busy} action={clearCredential} />}
      </>}
    </>}
    <Pressable accessibilityRole="button" accessibilityLabel={t('Save')} disabled={saveDisabled} onPress={() => { void data.run(async (core) => { const secret = auth === 'key' && (key.trim() || headers.trim()) ? { ...(key.trim() ? { apiKey: key.trim() } : {}), ...(headers.trim() ? { headers: JSON.parse(headers) } : {}) } : undefined; const saved = await core.connections.save({ name: label, preset, protocol, endpoint: url, auth }, id, old?.revision); if (secret) await core.connections.credential(saved.id, secret); if (id) router.back(); else router.replace({ pathname: '/models/connection', params: { id: saved.id } }); }); }} style={({ pressed }) => [s.saveButton, { backgroundColor: c.accent }, pressed && !saveDisabled && { opacity: .82 }, saveDisabled && { opacity: .4 }]}>
      <Text style={[type.label, { color: c.onAccent }]}>{t('Save')}</Text>
    </Pressable>
  </Frame>;
}

export function ModelEditor() {
  const { id, model: identity } = useLocalSearchParams<{ id: string; model?: string }>(); const data = useConfiguration(); const { t } = useI18n(); const { c } = data; const row = data.rows.find((row) => row.id === id); const existing = data.models.find((model) => model.id === identity);
  const [upstream, setUpstream] = useState(''); const [label, setLabel] = useState(''); const [context, setContext] = useState('128000'); const [limit, setLimit] = useState('16384'); const [levels, setLevels] = useState<ModelThinkingLevel[]>(['off']);
  const [max, setMax] = useState('16384'); const [temperature, setTemperature] = useState(''); const [cache, setCache] = useState(''); const [timeout, setTimeout] = useState(''); const [sampling, setSampling] = useState(''); const [compat, setCompat] = useState(''); const [advanced, setAdvanced] = useState(false); const initialized = useRef(false);
  useEffect(() => { if (existing && !initialized.current) { initialized.current = true; const { definition: model, generation: gen } = existing; setUpstream(model.id); setLabel(model.name); setContext(String(model.contextWindow)); setLimit(String(model.maxTokens)); setLevels(getSupportedThinkingLevels(model)); setMax((gen.maxTokens ?? model.maxTokens).toString()); setTemperature(gen.temperature?.toString() ?? ''); setCache(gen.cacheRetention ?? ''); setTimeout(gen.timeoutMs ? String(gen.timeoutMs / 1000) : ''); setSampling(gen.samplingParams ? JSON.stringify(gen.samplingParams, null, 2) : ''); setCompat(model.compat ? JSON.stringify(model.compat, null, 2) : ''); } }, [existing]);
  const catalog = existing?.source === 'catalog'; const enabled = existing?.enabled ?? true; const definition = existing?.definition ?? { api: row?.protocol ?? 'openai-completions', compat: undefined } as Model<Api>; const capabilities = modelCapabilities(definition);
  async function save(core: Workspace) {
    const generation: Generation = { ...(max.trim() ? { maxTokens: Number(max) } : {}), ...(temperature.trim() ? { temperature: Number(temperature) } : {}), ...(cache ? { cacheRetention: cache as Generation['cacheRetention'] } : {}), ...(timeout.trim() ? { timeoutMs: Number(timeout) * 1000 } : {}), ...(sampling.trim() ? { samplingParams: JSON.parse(sampling) } : {}) };
    if (catalog) await core.connections.updateModel(identity!, generation, enabled);
    else await core.connections.manual(id, { id: upstream, name: label, contextWindow: Number(context), maxTokens: Number(limit), thinking: levels, ...(compat.trim() ? { compat: JSON.parse(compat) } : {}) }, generation, enabled, identity);
    router.back();
  }
  const levelsList = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ModelThinkingLevel[];
  return <Frame title={t(identity ? 'Model parameters' : 'Add model')} data={data}>{row && <>
    <EditorField title="Model ID" value={upstream} change={setUpstream} c={c} editable={!identity && !data.busy} placeholder="model-id" />
    <EditorField title="Model display name" value={label} change={setLabel} c={c} editable={!catalog && !data.busy} />
    {!catalog && <>
      <EditorField title="Context token limit" value={context} change={setContext} c={c} numeric editable={!data.busy} />
      <EditorField title="Model output token limit" value={limit} change={setLimit} c={c} numeric editable={!data.busy} />
      <Text style={[s.editorLabel, { color: c.quiet }]}>{t('Thinking level')}</Text>
      <MultiOptionStrip values={levelsList} selected={levels} disabled={data.busy} c={c} onToggle={(value) => { const level = value as ModelThinkingLevel; setLevels((current) => current.includes(level) ? current.length === 1 ? current : current.filter((item) => item !== level) : [...current, level]); }} />
    </>}
    <EditorField title="Reply token budget" value={max} change={setMax} c={c} numeric editable={!data.busy} placeholder={t('Use the model limit by default')} />
    {capabilities.temperature && <EditorField title="Temperature" value={temperature} change={setTemperature} c={c} numeric editable={!data.busy} placeholder={t('Blank uses the service default')} />}
    <ActionRow icon="sliders" label={advanced ? '收起高级参数' : '高级参数'} c={c} action={() => setAdvanced(!advanced)} />
    {advanced && <>
      <EditorField title="Request timeout (seconds)" value={timeout} change={setTimeout} c={c} numeric editable={!data.busy} placeholder="90" />
      {capabilities.cache && <>
        <Text style={[s.editorLabel, { color: c.quiet }]}>{t('Cache retention')}</Text>
        <OptionStrip values={['服务默认', 'none', 'short', 'long']} selected={cache || '服务默认'} c={c} disabled={data.busy} onSelect={(value) => setCache(value === '服务默认' ? '' : value)} />
      </>}
      {capabilities.sampling && <EditorField title="Sampling JSON" value={sampling} change={setSampling} c={c} multiline editable={!data.busy} placeholder={'{"top_p":0.9}'} />}
      {!catalog && row.protocol !== 'google-generative-ai' && <EditorField title="Compatibility JSON" value={compat} change={setCompat} c={c} multiline editable={!data.busy} placeholder={'{"supportsDeveloperRole":false}'} />}
    </>}
    <Pressable accessibilityRole="button" accessibilityLabel={t('Save')} disabled={data.busy || !!identity && !existing} onPress={() => { void data.run(save); }} style={({ pressed }) => [s.saveButton, { backgroundColor: c.accent }, pressed && !(data.busy || !!identity && !existing) && { opacity: .82 }, (data.busy || !!identity && !existing) && { opacity: .4 }]}>
      <Text style={[type.label, { color: c.onAccent }]}>{t('Save')}</Text>
    </Pressable>
  </>}</Frame>;
}

const s = StyleSheet.create({
  headerWrap: { position: 'relative', zIndex: 20 },
  errorNotice: { position: 'absolute', left: 0, right: 0, top: '100%', minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 4 },
  errorClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  connectionPage: { paddingBottom: 8 },
  sectionLabel: { ...type.eyebrow, marginBottom: 4 },
  listTabs: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 18, marginBottom: 6 },
  listTab: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  listRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
  rowBrand: { width: 22, alignItems: 'center', justifyContent: 'center' },
  rowInitial: { fontFamily: 'Georgia', fontSize: 18, lineHeight: 22 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { ...type.list },
  addRow: { marginTop: 8 },
  modelLine: { minHeight: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  modelName: { fontSize: 15, lineHeight: 22, fontWeight: '500', letterSpacing: -0.2 },
  modelCheck: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  loginIdentity: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  loginBusy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
 screen: { flex: 1 }, header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 }, back: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, body: { padding: 20, paddingBottom: 48, gap: 12 }, headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  editorLabel: { ...type.caption },
  localModel: { paddingTop: 14 },
  localModelRow: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 58 },
  localModelMain: { flex: 1, minWidth: 0, gap: 2 },
  editorField: { gap: 6 },
  editorInput: { ...type.body, minHeight: 48, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  editorMultiline: { ...type.code, minHeight: 120, textAlignVertical: 'top' },
  optionStrip: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingVertical: 4, paddingRight: 20 },
  optionItem: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 },
  optionText: { ...type.label },
  saveButton: { minHeight: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12 }, connectionMeta: { gap: 3, marginBottom: 18 }, connectionMetaLine: { ...type.caption },
  connectionAction: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 20, marginHorizontal: -20 },
  groupLabel: { ...type.eyebrow, marginTop: 26, marginBottom: 2 },
  connectionModel: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 2 },
  connectionModelCheck: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  connectionModelMain: { flex: 1, minHeight: 52, justifyContent: 'center', gap: 2 },
  connectionToast: { position: 'absolute', left: 20, right: 20, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, zIndex: 20 },
loginCode: { ...type.title, letterSpacing: 4, marginTop: 6 }, loginPrimary: { minHeight: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, paddingHorizontal: 14 }, loginCancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 10 } });
