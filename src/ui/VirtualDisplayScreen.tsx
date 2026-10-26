import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { adb } from '../../modules/rxd/adb';
import { adbReady } from '../adb/state';
import { virtualDisplayError, virtualDisplayLabel, virtualDisplayReady, type LaunchableApp, type VirtualDisplayState } from '../virtual-display/state';
import { useI18n } from '../i18n';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

export default function VirtualDisplayScreen() {
  const { t } = useI18n(); const { c } = useTheme();
  const [state, setState] = useState<VirtualDisplayState>();
  const [authorized, setAuthorized] = useState(false), [working, setWorking] = useState(false), [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(''), [apps, setApps] = useState<LaunchableApp[]>([]), [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<LaunchableApp>(), [preview, setPreview] = useState<string>(), [error, setError] = useState('');
  const alive = useRef(true), locked = useRef(false), catalogRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 5000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    let live = true; const identity = ++catalogRequest.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void adb().virtualDisplayApps(query, 0).then((page) => {
        if (live && identity === catalogRequest.current) { setApps(page.apps); setNext(page.nextOffset); }
      }).catch(() => { if (live) setError('Could not load launcher apps.'); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  useFocusEffect(useCallback(() => {
    let focused = true;
    function refresh() {
      try {
        const current = adb().virtualDisplayStatus();
        if (focused) {
          setState(current); setAuthorized(adbReady(adb().status()));
          if (!virtualDisplayReady(current)) setPreview(undefined);
        }
      } catch { if (focused) setError('ADB is unavailable. Install an updated Android build.'); }
    }
    refresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 1000);
    return () => {
      focused = false; clearInterval(timer);
      // A test screen owns its session. Navigating away explicitly releases it.
      void Promise.resolve().then(() => adb().stopVirtualDisplay()).catch(() => undefined);
    };
  }, []));
  const ready = virtualDisplayReady(state);
  const canStop = !!state && !['stopped', 'disabled', 'unsupported'].includes(state.phase);
  const busy = working || state?.phase === 'starting' || state?.phase === 'stopping';
  async function capture() {
    try {
      const expected = adb().virtualDisplayStatus().displayId;
      const result = await adb().virtualDisplaySnapshot();
      if (!alive.current) return;
      if (result.error) { setError(virtualDisplayError(result.error)); return; }
      if (result.image && adb().virtualDisplayStatus().displayId === expected) setPreview('data:image/jpeg;base64,' + result.image);
    } catch { if (alive.current) setError(virtualDisplayError('no_frame')); }
  }
  async function start() {
    if (locked.current || !selected) return;
    locked.current = true; setWorking(true); setError(''); setPreview(undefined);
    try {
      const result = await adb().startVirtualDisplay(selected.packageName);
      if (alive.current) {
        setState(result);
        if (result.error) setError(virtualDisplayError(result.error));
        else if (virtualDisplayReady(result)) await capture();
      }
    } catch { if (alive.current) setError(virtualDisplayError('start_failed')); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  function stop() {
    setPreview(undefined);
    void adb().stopVirtualDisplay().then((result) => {
      if (alive.current) { setState(result); setError(result.error ? virtualDisplayError(result.error) : ''); }
    }).catch(() => { if (alive.current) setError(virtualDisplayError('cleanup_pending')); });
  }
  function more() {
    if (next === null || loading) return;
    const identity = catalogRequest.current;
    setLoading(true);
    void adb().virtualDisplayApps(query, next).then((page) => {
      if (alive.current && identity === catalogRequest.current) { setApps((rows) => [...rows, ...page.apps]); setNext(page.nextOffset); }
    }).catch(() => { if (alive.current) setError('Could not load launcher apps.'); })
      .finally(() => { if (alive.current) setLoading(false); });
  }
  return <KeyboardAvoidingView behavior="height" style={ui.screen}><SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}>
    <View style={s.headerWrap}><View style={ui.header}>
      <Pressable testID="vd-back" accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => router.back()} style={ui.back}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { flex: 1, color: c.heading }]}>{t('Virtual Display experiment')}</Text>
      {busy && <BusyIndicator color={c.accent} />}
      <Pressable testID="vd-stop" accessibilityRole="button" accessibilityLabel={t('Stop virtual display')} disabled={!canStop} onPress={stop} style={[ui.back, !canStop && { opacity: .35 }]}><Icon name="stop" color={c.quiet} size={19} /></Pressable>
    </View>{!!error && <View accessibilityRole="alert" style={[s.error, { backgroundColor: c.wash }]}><Text numberOfLines={5} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={() => setError('')} style={ui.back}><Icon name="close" size={16} color={c.danger} /></Pressable></View>}</View>
    <ScrollView contentContainerStyle={[ui.body, { paddingTop: 14 }]} keyboardShouldPersistTaps="handled">
      <Text testID="vd-status" style={[type.list, { color: ready ? c.accent : c.text }]}>{t(virtualDisplayLabel(state))}</Text>
      {!authorized && <Pressable testID="vd-adb" accessibilityRole="button" accessibilityLabel={t('ADB authorization')} onPress={() => router.push('/adb')} style={s.row}><Icon name="plug" color={c.accent} size={18} /><Text style={[type.list, { color: c.accent }]}>{t('ADB authorization')}</Text></Pressable>}
      {state?.phase === 'disabled' && <Pressable testID="vd-experiments" accessibilityRole="button" accessibilityLabel={t('Experimental features')} onPress={() => router.push('/experiments')} style={s.row}><Text style={[type.list, { color: c.accent }]}>{t('Experimental features')}</Text></Pressable>}
      {!ready && state?.phase !== 'disabled' && <>
        <Text style={[type.caption, { color: c.quiet }]}>{t('Choose an app to launch in a new isolated display. Existing app tasks are never moved or force-stopped.')}</Text>
        <TextInput testID="vd-search" accessibilityLabel={t('Search launcher apps')} placeholder={t('Search launcher apps')} placeholderTextColor={c.faint} value={query} onChangeText={setQuery} editable={!busy} autoCorrect={false} autoCapitalize="none" maxLength={128} style={[s.input, { color: c.text, backgroundColor: c.code }]} />
        <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={s.apps}>
          {apps.map((app) => <Pressable testID={'vd-app-' + app.packageName} key={app.packageName} accessibilityRole="radio" accessibilityLabel={app.label} accessibilityState={{ selected: selected?.packageName === app.packageName, disabled: busy }} disabled={busy} onPress={() => setSelected(app)} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
            <Text numberOfLines={1} style={[type.list, { flex: 1, minWidth: 0, color: selected?.packageName === app.packageName ? c.accent : c.text }]}>{app.label}</Text>
            {selected?.packageName === app.packageName && <Icon name="check" color={c.accent} size={16} />}
          </Pressable>)}
          {next !== null && <Pressable accessibilityRole="button" accessibilityLabel={t('Load more apps')} disabled={loading} onPress={more} style={s.row}><Text style={[type.caption, { color: c.accent }]}>{t('Load more apps')}</Text></Pressable>}
        </ScrollView>
        {selected && <Text numberOfLines={1} selectable style={[type.mono, { color: c.quiet }]}>{selected.packageName}</Text>}
        <Pressable testID="vd-start" accessibilityRole="button" accessibilityLabel={t('Launch on virtual display')} disabled={!selected || !authorized || busy || state?.phase === 'unsupported'} onPress={() => { void start(); }} style={[s.row, (!selected || !authorized || busy || state?.phase === 'unsupported') && { opacity: .35 }]}><Icon name="power" color={c.accent} size={18} /><Text numberOfLines={1} style={[type.list, { color: c.accent, flexShrink: 1 }]}>{t('Launch on virtual display')}</Text>{loading && <BusyIndicator color={c.accent} />}</Pressable>
      </>}
      {ready && <>
        <Text testID="vd-identity" selectable style={[type.mono, { color: c.quiet }]}>{state!.packageName + '\nDisplay ' + state!.displayId + ' · Task ' + state!.taskId + ' · UID ' + state!.uid + '\n' + state!.width + ' × ' + state!.height + ' · ' + state!.densityDpi + ' dpi'}</Text>
        <Pressable testID="vd-snapshot" accessibilityRole="button" accessibilityLabel={t('Refresh preview')} onPress={() => { void capture(); }} style={s.row}><Icon name="refresh" color={c.accent} size={18} /><Text style={[type.list, { color: c.accent }]}>{t('Refresh preview')}</Text></Pressable>
        {preview && <Image testID="vd-preview" accessibilityLabel={t('Read-only virtual display preview')} source={{ uri: preview }} resizeMode="contain" style={{ width: '100%', aspectRatio: state!.width / state!.height, backgroundColor: c.code }} />}
      </>}
      <Text style={[type.caption, { color: c.quiet, marginTop: 18 }]}>{t('Preview only. Touch and keyboard input are not forwarded. Leaving this page destroys the virtual display and its tasks.')}</Text>
      <Text style={[type.caption, { color: c.quiet }]}>{t('Android 15+ and a verified ADB shell are required. Protected app content may appear black.')}</Text>
    </ScrollView>
  </SafeAreaView></KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  headerWrap: { zIndex: 2 },
  error: { position: 'absolute', top: '100%', left: 0, right: 0, minHeight: 48, paddingLeft: 20, flexDirection: 'row', alignItems: 'center' },
  input: { ...type.body, minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  apps: { maxHeight: 240 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
});
