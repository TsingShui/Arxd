import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Appearance, View, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { getAndroidWorkspace } from '../workspace/android';
import type { AppearanceMode, MotionMode, Palette, WorkspaceSnapshot } from '../workspace/core';
import { colorsFor, type ColorScheme, type Colors } from './theme';
import Rxd from '../../modules/rxd';

type Preferences = { palette: Palette; appearance: AppearanceMode; motion: MotionMode };
type Theme = Preferences & { c: Colors; scheme: ColorScheme; reducedMotion: boolean; ready: boolean };
const initial: Preferences = { palette: 'fire', appearance: 'system', motion: 'system' };
const ThemeContext = createContext<Theme>({ ...initial, c: colorsFor('fire', 'dark'), scheme: 'dark', reducedMotion: true, ready: false });
let observed: Omit<Theme, 'c'> & { background: string; accent: string } = { ...initial, scheme: 'dark', reducedMotion: true, ready: false, background: colorsFor('fire', 'dark').background, accent: colorsFor('fire', 'dark').accent };
let reporting = false;
export function enableThemeReporting() { reporting = true; Rxd.report(JSON.stringify({ event: 'arxd-theme', ...observed })); }
export function themeSnapshot() { return observed; }

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
void SystemUI.setBackgroundColorAsync(colorsFor('fire', Appearance.getColorScheme() === 'light' ? 'light' : 'dark').background).catch(() => undefined);

/** One app-wide appearance owner; screens never guess colors from a palette name. */
export function AppearanceProvider({ children, standalone = false }: { children: ReactNode; standalone?: boolean }) {
  const native = useColorScheme();
  const [preferences, setPreferences] = useState(initial);
  // Once navigation has mounted, switching route ownership must not unmount
  // it while normal workspace preferences hydrate.
  const [ready, setReady] = useState(standalone);
  if (standalone && !ready) setReady(true);
  const [systemReduced, setSystemReduced] = useState(true);
  useEffect(() => {
    if (standalone) return;
    let alive = true; let unsubscribe: (() => void) | undefined;
    const update = (snapshot: WorkspaceSnapshot) => { if (alive) setPreferences((old) => old.palette === snapshot.palette && old.appearance === snapshot.appearance && old.motion === snapshot.motion ? old : { palette: snapshot.palette, appearance: snapshot.appearance, motion: snapshot.motion }); };
    void getAndroidWorkspace().then((core) => { if (!alive) return; update(core.getSnapshot()); unsubscribe = core.subscribe(update); setReady(true); }).catch(() => { if (alive) setReady(true); });
    return () => { alive = false; unsubscribe?.(); };
  }, [standalone]);
  useEffect(() => {
    let alive = true; let changed = false;
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => { changed = true; if (alive) setSystemReduced(value); });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive && !changed) setSystemReduced(value); }).catch(() => undefined);
    return () => { alive = false; listener.remove(); };
  }, []);
  useEffect(() => { if (ready) Appearance.setColorScheme(preferences.appearance === 'system' ? 'auto' : preferences.appearance); }, [preferences.appearance, ready]);
  const scheme: ColorScheme = preferences.appearance === 'system' ? native === 'dark' ? 'dark' : 'light' : preferences.appearance;
  const c = colorsFor(preferences.palette, scheme);
  const reducedMotion = preferences.motion === 'reduced' || systemReduced;
  const theme = useMemo(() => ({ ...preferences, c, scheme, reducedMotion, ready }), [preferences, c, scheme, reducedMotion, ready]);
  useEffect(() => {
    observed = { ...preferences, scheme, reducedMotion, ready, background: c.background, accent: c.accent };
    if (reporting) Rxd.report(JSON.stringify({ event: 'arxd-theme', ...observed }));
    void SystemUI.setBackgroundColorAsync(c.background).catch(() => undefined);
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [preferences, scheme, reducedMotion, ready, c]);
  return <ThemeContext.Provider value={theme}><View style={{ flex: 1, backgroundColor: c.background }}><StatusBar style={scheme === 'dark' ? 'light' : 'dark'} animated={!reducedMotion} />{ready ? children : null}</View></ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
