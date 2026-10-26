import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { appWindows } from '../../modules/rxd/windows';
import { splitScreenError, splitScreenLabel, type SplitScreenState } from '../split-screen/state';
import type { LaunchableApp } from '../virtual-display/state';
import { useI18n } from '../i18n';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

export default function SplitScreenScreen() {
  const { t } = useI18n(); const { c } = useTheme();
  const [state, setState] = useState<SplitScreenState>(), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [apps, setApps] = useState<LaunchableApp[]>([]);
  const [selected, setSelected] = useState<LaunchableApp>(), [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [guide, setGuide] = useState(false);
  const alive = useRef(true), locked = useRef(false), catalog = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 5000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    let live = true; const identity = ++catalog.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void appWindows().launcherApps(query, 0).then((page) => {
        if (live && identity === catalog.current) { setApps(page.apps); setNext(page.nextOffset); }
      }).catch(() => { if (live) setError('Could not load launcher apps.'); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  useFocusEffect(useCallback(() => {
    let live = true, refreshing = false;
    async function refresh() {
      if (refreshing || locked.current) return;
      refreshing = true;
      try { const value = await appWindows().splitStatus(); if (live) setState(value); }
      catch { if (live) setError('Could not read window status. Install an updated Android build.'); }
      finally { refreshing = false; }
    }
    void refresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, []));
  async function launch() {
    if (!selected || locked.current) return;
    locked.current = true; setWorking(true); setError('');
    try {
      const result = await appWindows().launchAdjacent(selected.packageName);
      if (alive.current) { setState(result); if (result.error) setError(splitScreenError(result.error)); }
    } catch { if (alive.current) setError(splitScreenError()); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  function more() {
    if (next === null || loading) return;
    const identity = catalog.current; setLoading(true);
    void appWindows().launcherApps(query, next).then((page) => {
      if (alive.current && identity === catalog.current) { setApps((rows) => [...rows, ...page.apps]); setNext(page.nextOffset); }
    }).catch(() => { if (alive.current) setError('Could not load launcher apps.'); })
      .finally(() => { if (alive.current) setLoading(false); });
  }
  return <KeyboardAvoidingView behavior="height" style={ui.screen}><SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}>
    <View style={s.headerWrap}><View style={ui.header}>
      <Pressable testID="split-back" accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => router.back()} style={ui.back}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { flex: 1, color: c.heading }]}>{t('Split-screen analysis')}</Text>
      {(working || loading) && <BusyIndicator color={c.accent} />}
    </View>{!!error && <View accessibilityRole="alert" style={[s.error, { backgroundColor: c.wash }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={() => setError('')} style={ui.back}><Icon name="close" size={16} color={c.danger} /></Pressable></View>}</View>
    <ScrollView contentContainerStyle={[ui.body, { paddingTop: 14 }]} keyboardShouldPersistTaps="handled">
      <Text testID="split-status" style={[type.caption, { color: c.quiet }]}>{t(splitScreenLabel(state))}</Text>
      <Text style={[type.caption, { color: c.quiet }]}>{t('Choose an app to use beside Arxd. Android controls the layout; existing app tasks may be reused.')}</Text>
      <TextInput testID="split-search" accessibilityLabel={t('Search launcher apps')} placeholder={t('Search launcher apps')} placeholderTextColor={c.faint} value={query} onChangeText={setQuery} editable={!working} autoCorrect={false} autoCapitalize="none" maxLength={128} style={[s.input, { color: c.text, backgroundColor: c.code }]} />
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={s.apps}>
        {apps.map((app) => <Pressable key={app.packageName} testID={'split-app-' + app.packageName} accessibilityRole="radio" accessibilityLabel={app.label} accessibilityState={{ selected: selected?.packageName === app.packageName, disabled: working }} disabled={working} onPress={() => setSelected(app)} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
          <Text numberOfLines={1} style={[type.list, { flex: 1, minWidth: 0, color: selected?.packageName === app.packageName ? c.accent : c.text }]}>{app.label}</Text>
          {selected?.packageName === app.packageName && <Icon name="check" color={c.accent} size={16} />}
        </Pressable>)}
        {next !== null && <Pressable accessibilityRole="button" accessibilityLabel={t('Load more apps')} disabled={loading} onPress={more} style={s.row}><Text style={[type.caption, { color: c.accent }]}>{t('Load more apps')}</Text></Pressable>}
      </ScrollView>
      {selected && <Text numberOfLines={1} selectable style={[type.mono, { color: c.quiet }]}>{selected.packageName}</Text>}
      <Pressable testID="split-launch" accessibilityRole="button" accessibilityLabel={t('Open app beside Arxd')} disabled={!selected || !state?.supported || working} onPress={() => { void launch(); }} style={[s.row, (!selected || !state?.supported || working) && { opacity: .35 }]}><Icon name="grid" color={c.accent} size={18} /><Text numberOfLines={1} style={[type.list, { color: c.accent, flexShrink: 1 }]}>{t('Open app beside Arxd')}</Text></Pressable>
      <Pressable testID="split-conversation" accessibilityRole="button" accessibilityLabel={t('Continue in conversation')} onPress={() => router.replace('/')} style={s.row}><Icon name="back" color={c.accent} size={18} /><Text numberOfLines={1} style={[type.list, { color: c.accent, flexShrink: 1 }]}>{t('Continue in conversation')}</Text></Pressable>
      <Pressable testID="split-manual" accessibilityRole="button" accessibilityLabel={t('Manual split-screen')} onPress={() => setGuide((value) => !value)} style={s.row}><Text style={[type.caption, { color: c.accent }]}>{t('Manual split-screen')}</Text></Pressable>
      {guide && <Text style={[type.caption, { color: c.quiet }]}>{t('Open Recents, tap the app icon, choose Split screen, then select the other app.')}</Text>}
      <Text style={[type.caption, { color: c.quiet }]}>{t("Split screen only arranges windows. It does not read, control or send the other app's screen to a model.")}</Text>
    </ScrollView>
  </SafeAreaView></KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  headerWrap: { zIndex: 2 },
  error: { position: 'absolute', top: '100%', left: 0, right: 0, minHeight: 48, paddingLeft: 20, flexDirection: 'row', alignItems: 'center' },
  input: { ...type.body, minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  apps: { maxHeight: 192 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
});
