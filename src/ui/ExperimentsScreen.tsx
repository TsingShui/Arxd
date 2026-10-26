import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { adb } from '../../modules/rxd/adb';
import { useI18n } from '../i18n';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

export default function ExperimentsScreen() {
  const { t } = useI18n(); const { c } = useTheme();
  const [state, setState] = useState<{ virtualDisplay: boolean; cleanupPending: boolean }>();
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 5000); return () => clearTimeout(timer); }, [error]);
  useFocusEffect(useCallback(() => {
    try { setState(adb().experiments()); }
    catch { setError('Could not load experimental features. Install an updated Android build.'); }
  }, []));
  async function toggle() {
    if (!state || locked.current) return;
    locked.current = true; setWorking(true); setError('');
    try {
      const value = await adb().setVirtualDisplayExperiment(!state.virtualDisplay);
      if (alive.current) {
        setState(value);
        if (value.cleanupPending) setError('Cleanup could not be confirmed. The controller lease will expire; check again shortly.');
      }
    } catch { if (alive.current) setError('Could not update experimental features.'); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  return <SafeAreaView edges={['top', 'bottom']} style={[ui.screen, { backgroundColor: c.background }]}>
    <View style={s.headerWrap}><View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => router.back()} style={ui.back}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { flex: 1, color: c.heading }]}>{t('Experimental features')}</Text>
      {working && <BusyIndicator color={c.accent} />}
    </View>{!!error && <View accessibilityRole="alert" style={[s.error, { backgroundColor: c.wash }]}><Text numberOfLines={4} style={[type.caption, { color: c.danger, flex: 1 }]}>{t(error)}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss the error')} onPress={() => setError('')} style={ui.back}><Icon name="close" size={16} color={c.danger} /></Pressable></View>}</View>
    <ScrollView contentContainerStyle={[ui.body, { paddingTop: 14 }]}>
      <Pressable testID="experiment-virtual-display" accessibilityRole="switch" accessibilityLabel={t('Enable Virtual Display')} accessibilityState={{ checked: state?.virtualDisplay ?? false, disabled: !state || working }} disabled={!state || working} onPress={() => { void toggle(); }} style={[s.row, (!state || working) && { opacity: .35 }]}>
        <Text numberOfLines={1} style={[type.list, { color: c.text, flex: 1 }]}>{t('Virtual Display experiment')}</Text>
        {state?.virtualDisplay ? <Icon name="check" color={c.accent} size={18} /> : <Icon name="close" color={c.faint} size={16} />}
      </Pressable>
      <Text style={[type.caption, { color: c.quiet }]}>{t('Virtual Display is experimental and disabled by default. It requires Android 15+ and verified ADB. Input forwarding is not available.')}</Text>
      <Text style={[type.caption, { color: c.quiet }]}>{t('Disabling this experiment stops its virtual display session.')}</Text>
      {state?.virtualDisplay && <Pressable testID="experiment-open-virtual-display" accessibilityRole="button" accessibilityLabel={t('Open Virtual Display experiment')} onPress={() => router.push('/virtual-display')} style={s.row}><Text numberOfLines={1} style={[type.list, { color: c.accent, flex: 1 }]}>{t('Open Virtual Display experiment')}</Text><Icon name="right" color={c.accent} size={18} /></Pressable>}
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  headerWrap: { zIndex: 2 },
  error: { position: 'absolute', top: '100%', left: 0, right: 0, minHeight: 48, paddingLeft: 20, flexDirection: 'row', alignItems: 'center' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
});
