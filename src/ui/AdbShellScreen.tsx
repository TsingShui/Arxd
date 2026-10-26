import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Rxd from '../../modules/rxd';
import { adb } from '../../modules/rxd/adb';
import { ADB_INSTALL, TermuxAdb } from '../adb/termux';
import { adbPort } from '../adb/state';
import { agentSessions, backgroundSession, enableBackground } from '../background/android';
import { androidServices } from '../workspace/native-services';
import { useI18n } from '../i18n';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

function Action({ label, id, onPress, disabled = false }: { label: string; id: string; onPress: () => void; disabled?: boolean }) {
  const { t } = useI18n(), { c } = useTheme();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={t(label)} onPress={onPress} disabled={disabled} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }, disabled && { opacity: .35 }]}><Text numberOfLines={1} style={[type.list, { color: c.accent }]}>{t(label)}</Text></Pressable>;
}

export default function AdbShellScreen() {
  const { t } = useI18n(), { c } = useTheme();
  const [enabled, setEnabled] = useState(() => { try { return backgroundSession().status().enabled; } catch { return false; } }), [working, setWorking] = useState(false);
  const [output, setOutput] = useState(''), [error, setError] = useState('');
  const [pairPort, setPairPort] = useState(''), [code, setCode] = useState(''), [port, setPort] = useState('');
  const [script, setScript] = useState('adb devices\nadb shell id');
  const alive = useRef(true), locked = useRef(false), request = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 6000); return () => clearTimeout(timer); }, [error]);
  const run = async (text: string, timeout: number) => {
    const id = 'adb-cli-' + globalThis.crypto.randomUUID();
    request.current = id; Rxd.registerShell(id);
    try {
      const result = await Rxd.runShell(id, text, timeout);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'ADB operation failed.');
      return result;
    } finally { request.current = undefined; }
  };
  const cli = () => new TermuxAdb(androidServices, () => globalThis.crypto.randomUUID(), run);
  async function perform(operation: (cancelled: () => boolean) => Promise<string>) {
    if (locked.current) return;
    locked.current = true; setWorking(true); setError('');
    let cancelled = false;
    try {
      await enableBackground(true); if (alive.current) setEnabled(true);
      const result = await agentSessions.run(() => operation(() => cancelled), () => {
        cancelled = true;
        if (request.current) Rxd.cancelShell(request.current);
      });
      if (alive.current) setOutput(result);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'ADB operation failed.'); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  function field(label: string, value: string, change: (text: string) => void, id: string, secret = false) {
    return <TextInput testID={id} accessibilityLabel={t(label)} placeholder={t(label)} placeholderTextColor={c.faint} value={value} onChangeText={change} secureTextEntry={secret} editable={!working} keyboardType="number-pad" maxLength={secret ? 6 : 5} autoComplete="off" importantForAutofill="noExcludeDescendants" style={[s.input, { color: c.text, backgroundColor: c.code }]} />;
  }
  function pair() {
    const p = adbPort(pairPort), secret = code; setCode('');
    if (!p || !/^[0-9]{6}$/.test(secret)) { setError('Enter valid pairing port and six-digit code.'); return; }
    void perform(async (cancelled) => {
      const record = await cli().pair(p, secret, cancelled);
      while (true) {
        if (cancelled()) { await androidServices.stop(record.id); throw new Error('Cancelled'); }
        const current = await androidServices.inspect(record.id);
        if (current.state === 'exited' || current.state === 'failed' || current.state === 'lost') {
          const log = await androidServices.logs(record.id, 'stdout', -1, 8192);
          if (current.exitCode !== 0) throw new Error(log.text || current.reason || 'ADB operation failed.');
          return log.text || 'Paired';
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    });
  }
  return <SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}>
    <View style={s.header}><View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => router.back()} style={ui.back}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{t('ADB Shell')}</Text>
      {working && <BusyIndicator color={c.accent} />}
      <Action label="Stop" id="adb-cli-cancel" onPress={() => backgroundSession().stop()} disabled={!working} />
    </View>{!!error && <View accessibilityRole="alert" style={[s.error, { backgroundColor: c.wash }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={() => setError('')} style={ui.back}><Icon name="close" color={c.danger} size={16} /></Pressable></View>}</View>
    <ScrollView contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled">
      <Text style={[type.caption, { color: c.quiet }]}>{t('Real Termux android-tools. No ADB command whitelist. Pairing authorizes device-wide shell operations, not root.')}</Text>
      <Pressable testID="background-enabled" accessibilityRole="switch" accessibilityLabel={t('Background Agent sessions')} accessibilityState={{ checked: enabled }} disabled={working} onPress={() => { void enableBackground(!enabled).then(() => setEnabled(!enabled)).catch((e) => setError(String(e))); }} style={s.row}>
        <Text numberOfLines={1} style={[type.list, { color: c.text, flex: 1 }]}>{t('Background Agent sessions')}</Text><Icon name={enabled ? 'check' : 'close'} color={enabled ? c.accent : c.faint} size={18} />
      </Pressable>
      <Text style={[type.caption, { color: c.quiet }]}>{t('Running sessions show a notification with Stop. No automatic replay of interrupted shell commands.')}</Text>
      <Action label="Install android-tools" id="adb-cli-install" disabled={working} onPress={() => { void perform(async () => { const r = await run(ADB_INSTALL, 600000); return r.stdout; }); }} />
      <Action label="Start ADB server" id="adb-cli-start" disabled={working} onPress={() => { void perform(async () => JSON.stringify(await cli().start(), null, 2)); }} />
      <Action label="Stop ADB server" id="adb-cli-stop" onPress={() => { void cli().stop().then(() => setOutput('')).catch((e) => setError(String(e))); }} />
      <Action label="Open Wireless debugging" id="adb-cli-settings" disabled={working} onPress={() => { void Promise.resolve().then(() => adb().openSettings()).catch(() => setError('Cannot open Android developer settings')); }} />
      <Text style={[type.caption, { color: c.quiet }]}>{t('This CLI uses its own private adb keys, separate from the Virtual Display client. Pair it separately.')}</Text>
      <View style={s.fields}>{field('Pairing port', pairPort, setPairPort, 'adb-cli-pair-port')}{field('Pairing code', code, setCode, 'adb-cli-code', true)}</View>
      <Action label="Pair device" id="adb-cli-pair" disabled={working} onPress={pair} />
      {field('Connection port', port, setPort, 'adb-cli-port')}
      <Action label="Connect" id="adb-cli-connect" disabled={working} onPress={() => {
        const p = adbPort(port); if (!p) { setError('Enter a valid connection port.'); return; }
        void perform(async () => (await cli().connect(p)).stdout);
      }} />
      <Text style={[type.caption, { color: c.quiet }]}>{t('App shell and ADB shell are different UIDs. Redirect screenshots to workspace files; do not print binary PNG to the text console.')}</Text>
      <TextInput testID="adb-cli-script" accessibilityLabel={t('Shell script')} value={script} onChangeText={setScript} editable={!working} multiline autoCorrect={false} autoCapitalize="none" maxLength={16384} style={[s.script, { color: c.text, backgroundColor: c.code }]} />
      <Action label="Run script" id="adb-cli-run" disabled={working} onPress={() => { void perform(async () => (await run(script, 600000)).stdout); }} />
      <ScrollView nestedScrollEnabled style={s.output}><Text testID="adb-cli-output" selectable style={[type.mono, { color: c.text }]}>{output}</Text></ScrollView>
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  header: { zIndex: 2 },
  error: { position: 'absolute', top: '100%', left: 0, right: 0, paddingLeft: 20, flexDirection: 'row', alignItems: 'center' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { ...type.body, flexGrow: 1, minHeight: 48, paddingHorizontal: 10, borderRadius: 8 },
  fields: { flexDirection: 'row', gap: 12, marginTop: 14 },
  script: { ...type.mono, minHeight: 120, padding: 10, textAlignVertical: 'top', borderRadius: 8, marginTop: 14 },
  output: { maxHeight: 260 },
});
