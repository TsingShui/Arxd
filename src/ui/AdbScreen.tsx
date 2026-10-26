import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { adb } from '../../modules/rxd/adb';
import { adbBusy, adbError, adbLabel, adbPort, adbReady, type AdbStatus } from '../adb/state';
import { useI18n } from '../i18n';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon, type IconName } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

function Action({ label, icon, onPress, disabled = false, id }: { label: string; icon: IconName; onPress: () => void; disabled?: boolean; id?: string }) {
  const { t } = useI18n(); const { c } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={t(label)} testID={id} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.action, pressed && { backgroundColor: c.wash }, disabled && { opacity: .35 }]}><Icon name={icon} color={c.accent} size={18} /><Text numberOfLines={1} style={[type.list, { color: c.accent, flexShrink: 1 }]}>{t(label)}</Text></Pressable>;
}

export default function AdbScreen() {
  const { t } = useI18n(); const { c } = useTheme();
  const [state, setState] = useState<AdbStatus>();
  const [pairPort, setPairPort] = useState(''), [code, setCode] = useState(''), [connectionPort, setConnectionPort] = useState('');
  const [error, setError] = useState(''), [waiting, setWaiting] = useState(false);
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 5000); return () => clearTimeout(timer); }, [error]);
  useFocusEffect(useCallback(() => {
    let focused = true;
    function update(verify = false) {
      try {
        const value = adb().status();
        if (focused) setState(value);
        if (verify && value.phase === 'connected') void adb().check().then((checked) => {
          if (focused) { setState(checked); if (checked.error) setError(adbError(checked.error)); }
        }).catch(() => { if (focused) setError('ADB operation failed.'); });
      } catch { if (focused) setError('ADB is unavailable. Install an updated Android build.'); }
    }
    update(true);
    const timer = setInterval(() => { if (AppState.currentState === 'active') update(); }, 750);
    const listener = AppState.addEventListener('change', (value) => { if (value === 'active') update(true); });
    return () => { focused = false; clearInterval(timer); listener.remove(); };
  }, []));
  const busy = waiting || adbBusy(state), ready = adbReady(state), supported = state?.supported === true;
  async function perform(action: () => Promise<AdbStatus>) {
    if (locked.current) return;
    locked.current = true; setWaiting(true); setError('');
    try {
      const result = await action();
      if (alive.current) { setState(result); if (result.error) setError(adbError(result.error)); }
    } catch { if (alive.current) setError('ADB operation failed.'); }
    finally { locked.current = false; if (alive.current) setWaiting(false); }
  }
  function pair() {
    const port = adbPort(pairPort);
    if (!port) { setError(adbError('invalid_port')); return; }
    if (!/^[0-9]{6}$/.test(code)) { setError(adbError('invalid_code')); return; }
    const password = code; setCode('');
    void perform(() => adb().pair(port, password));
  }
  function connect() {
    const port = adbPort(connectionPort);
    if (!port) { setError(adbError('invalid_port')); return; }
    void perform(() => adb().connect(port));
  }
  function disconnect() {
    // Do not queue cancellation behind the request it must interrupt.
    setCode('');
    void adb().disconnect().then((value) => { if (alive.current) { setState(value); setError(''); } })
      .catch(() => { if (alive.current) setError('ADB operation failed.'); });
  }
  function openSettings() { void Promise.resolve().then(() => adb().openSettings()).catch(() => { if (alive.current) setError('Cannot open Android developer settings'); }); }
  function field(label: string, value: string, change: (value: string) => void, id: string, secret = false) {
    return <View style={s.field}><Text numberOfLines={1} style={[type.caption, { color: c.quiet }]}>{t(label)}</Text><TextInput testID={id} accessibilityLabel={t(label)} value={value} onChangeText={change} editable={supported && !busy} keyboardType="number-pad" secureTextEntry={secret} autoCorrect={false} autoCapitalize="none" autoComplete="off" importantForAutofill="noExcludeDescendants" maxLength={secret ? 6 : 5} style={[s.input, { color: c.text, backgroundColor: c.code }]} /></View>;
  }
  return <KeyboardAvoidingView behavior="height" style={ui.screen}><SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}>
    <View style={s.headerWrap}><View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} testID="adb-back" onPress={() => router.back()} style={ui.back}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { flex: 1, color: c.heading }]}>{t('ADB authorization')}</Text>
      {busy ? <BusyIndicator color={c.accent} /> : <Pressable accessibilityRole="button" accessibilityLabel={t('Check connection')} testID="adb-check" disabled={!ready} onPress={() => { void perform(() => adb().check()); }} style={[ui.back, !ready && { opacity: .35 }]}><Icon name="refresh" color={c.quiet} size={18} /></Pressable>}
    </View>
    {!!error && <View accessibilityRole="alert" style={[s.error, { backgroundColor: c.wash }]}><Text numberOfLines={5} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={() => setError('')} style={ui.back}><Icon name="close" color={c.danger} size={16} /></Pressable></View>}</View>
    <ScrollView contentContainerStyle={[ui.body, { paddingTop: 12 }]} keyboardShouldPersistTaps="handled">
      <View style={s.status}><Icon name={ready ? 'check' : 'plug'} color={ready ? c.accent : c.quiet} size={19} /><Text testID="adb-status" numberOfLines={1} style={[type.list, { color: ready ? c.accent : c.text, flex: 1 }]}>{t(adbLabel(state))}</Text>{(ready || busy) && <Action label={busy ? 'Cancel' : 'Disconnect'} icon="close" onPress={disconnect} id="adb-disconnect" />}</View>
      {ready && <Text testID="adb-identity" selectable style={[type.mono, { color: c.quiet }]}>{'127.0.0.1:' + state!.port + ' · UID ' + state!.uid}</Text>}
      {state && !supported ? <Text style={[type.caption, { color: c.quiet }]}>{t('Wireless ADB requires Android 11 or newer.')}</Text> : <>
        <Text style={[type.caption, { color: c.quiet }]}>{t('Enable Wireless debugging in Developer options. Arxd connects only to this device (127.0.0.1).')}</Text>
        <Action label="Open Wireless debugging" icon="settings" onPress={openSettings} disabled={!state} id="adb-open-settings" />
        <Text style={[s.label, { color: c.faint }]}>{t('1. Pair this device')}</Text>
        <Text style={[type.caption, { color: c.quiet }]}>{t('Keep Android Settings and Arxd in split screen so the pairing dialog stays open.')}</Text>
        <View style={s.fields}><View style={s.grow}>{field('Pairing port', pairPort, setPairPort, 'adb-pair-port')}</View><View style={s.grow}>{field('Pairing code', code, setCode, 'adb-pair-code', true)}</View></View>
        <Action label="Pair device" icon="plug" onPress={pair} disabled={!supported || busy} id="adb-pair" />
        <Text style={[s.label, { color: c.faint }]}>{t('2. Connect')}</Text>
        <Text style={[type.caption, { color: c.quiet }]}>{t('Use the port on the main Wireless debugging page. It differs from the pairing port.')}</Text>
        {field('Connection port', connectionPort, setConnectionPort, 'adb-connect-port')}
        <Action label="Connect" icon="plug" onPress={connect} disabled={!supported || busy || !state?.paired} id="adb-connect" />
      </>}
      <Text style={[type.caption, { color: c.quiet, marginTop: 20 }]}>{t('Disconnect stops the channel, not device trust. To revoke access, forget Arxd in Android Wireless debugging.')}</Text>
      <Action label="ADB Shell" icon="terminal" onPress={() => router.push('/adb-shell')} id="adb-shell" />
      <Action label="Split-screen analysis" icon="grid" onPress={() => router.push('/split-screen')} id="adb-split-screen" />
      <Action label="Experimental features" icon="settings" onPress={() => router.push('/experiments')} id="adb-experiments" />
      <Text style={[type.caption, { color: c.quiet }]}>{t('This grants an ADB shell channel, not root. Virtual Display requires Android 15 or newer.')}</Text>
    </ScrollView>
  </SafeAreaView></KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  headerWrap: { zIndex: 2 },
  error: { position: 'absolute', top: '100%', left: 0, right: 0, minHeight: 48, paddingLeft: 20, flexDirection: 'row', alignItems: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  label: { ...type.eyebrow, marginTop: 22, marginBottom: 2 },
  fields: { flexDirection: 'row', gap: 16 },
  grow: { flex: 1 },
  field: { gap: 6 },
  input: { ...type.body, minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  action: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
});
