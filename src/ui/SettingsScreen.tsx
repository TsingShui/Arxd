import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n';
import Rxd from '../../modules/rxd';
import { MAX_IMPORT_BYTES } from '../workspace/limits.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { AppearanceMode, Palette, Workspace } from '../workspace/core';
import type { HttpMcpPolicy } from '../workspace/service-types';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { layout, type Colors } from './theme';
import { type } from './type';

function SettingRow({ label, selected, action, disabled, c, id }: { label: string; selected: boolean; action: () => void; disabled: boolean; c: Colors; id: string }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected, checked: selected, disabled }} accessibilityLabel={t(label)} testID={id} onPress={action} disabled={disabled} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}>
    <Text style={[type.list, { color: selected ? c.accent : c.text, flex: 1 }]}>{t(label)}</Text>
    {selected && <Icon name="check" size={16} color={c.accent} />}
  </Pressable>;
}

/// The import limit is edited in MiB because that is the unit users compare
/// against file managers; the stored value stays exact bytes.
function LimitRow({ value, disabled, action, c }: { value: number; disabled: boolean; action: (bytes: number) => void; c: Colors }) {
  const { t } = useI18n();
  const shown = String(Math.round(value / 1048576));
  const [draft, setDraft] = useState<string>();
  const text = draft ?? shown;
  const apply = () => {
    const mib = Number(text.trim());
    if (!Number.isSafeInteger(mib) || mib < 1 || mib > 8192) { setDraft(undefined); return; }
    action(mib * 1048576); setDraft(undefined);
  };
  return <View style={[s.row, { gap: 10 }]}>
    <Text style={[type.list, { color: c.text, flex: 1 }]}>{t('导入上限')}</Text>
    <TextInput value={text} onChangeText={setDraft} onEndEditing={apply} onSubmitEditing={apply} editable={!disabled} keyboardType="number-pad" returnKeyType="done" accessibilityLabel={t('导入上限（MiB），1 到 8192')} testID="import-limit" style={[s.limitInput, { color: c.text, backgroundColor: c.raised }]} />
    <Text style={[type.caption, { color: c.quiet }]}>MiB</Text>
  </View>;
}

function ToggleRow({ label, checked, action, disabled, c, id }: { label: string; checked: boolean; action: () => void; disabled: boolean; c: Colors; id: string }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} accessibilityLabel={t(label)} testID={id} onPress={action} disabled={disabled} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }, disabled && { opacity: .4 }]}>
    <Text style={[type.list, { color: c.text, flex: 1 }]}>{t(label)}</Text>
    <View style={[s.checkbox, { borderColor: checked ? c.accent : c.line, backgroundColor: checked ? c.accent : 'transparent' }]}>{checked && <Icon name="check" size={14} color={c.onAccent} />}</View>
  </Pressable>;
}

export default function SettingsScreen() {
  const { t } = useI18n();
  const { c, palette, appearance, motion } = useTheme();
  const [workspace, setWorkspace] = useState<Workspace>(); const [error, setError] = useState(''); const [pending, setPending] = useState(0); const [importLimit, setImportLimit] = useState(MAX_IMPORT_BYTES); const [httpPolicy, setHttpPolicy] = useState<HttpMcpPolicy>(); const [iconStyle, setIconStyle] = useState<'dark' | 'light'>(() => { try { return Rxd.getAppIcon(); } catch { return 'dark'; } });
  const [instructions, setInstructions] = useState<{ count: number; active: boolean }>({ count: 0, active: false });
  const alive = useRef(true); const request = useRef(0);
  useEffect(() => { alive.current = true; void getAndroidWorkspace().then((core) => { if (alive.current) { setWorkspace(core); setHttpPolicy(core.services?.mcp.httpPolicy()); setImportLimit(core.getSnapshot().importLimit); } }).catch((error) => { if (alive.current) setError(String(error)); }); return () => { alive.current = false; }; }, []);
  useFocusEffect(useCallback(() => { let live = true; if (!workspace) return () => { live = false; }; void workspace.prompts.get().then((value) => { if (live) setInstructions({ count: value.profiles.length, active: !!(value.active.cloud || value.active.local) }); }).catch((failure) => { if (live) setError(String(failure).replace(/^Error: /, '')); }); return () => { live = false; }; }, [workspace]));
  async function perform(action: (core: Workspace) => Promise<unknown>) {
    if (!workspace) return; const current = ++request.current; setPending((count) => count + 1); setError('');
    try { await action(workspace); } catch (error) { if (alive.current && current === request.current) setError(String(error).replace(/^Error: /, '')); }
    finally { if (alive.current) setPending((count) => count - 1); }
  }
  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={t('返回')} testID="settings-back" onPress={() => router.back()} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable><Text style={[type.heading, { flex: 1, color: c.heading }]}>{t('设置')}</Text>{pending > 0 && <BusyIndicator color={c.accent} />}</View>
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      {!!error && <Text selectable style={[s.error, { color: c.danger }]}>{error}</Text>}

      <Text style={[s.label, { color: c.faint, marginTop: 0 }]}>{t('外观')}</Text>
      <View accessibilityRole="radiogroup">
        {(['system', 'light', 'dark'] as AppearanceMode[]).map((value) => <SettingRow key={value} id={`appearance-${value}`} label={value === 'system' ? '跟随系统外观' : value === 'light' ? '浅色外观' : '深色外观'} selected={appearance === value} disabled={!workspace} c={c} action={() => { void perform((core) => core.appearance(value)); }} />)}
      </View>

      <Text style={[s.label, { color: c.faint }]}>{t('主题配色')}</Text>
      <View accessibilityRole="radiogroup" style={s.inlineGroup}>
        {(['fire', 'spring'] as Palette[]).map((value) => {
          const selected = palette === value;
          return <Pressable key={value} accessibilityRole="radio" accessibilityLabel={t('使用 {theme} 主题', { theme: value })} accessibilityState={{ selected, checked: selected, disabled: !workspace }} testID={`theme-${value}`} disabled={!workspace} onPress={() => { void perform((core) => core.theme(value)); }} style={({ pressed }) => [s.inlineOption, pressed && { opacity: .55 }, !workspace && { opacity: .4 }]}>
            <Text style={[type.list, { color: selected ? c.accent : c.text }]}>{value === 'fire' ? `Fire · ${t('野火')}` : `Spring · ${t('春风')}`}</Text>
            {selected && <Icon name="check" size={16} color={c.accent} />}
          </Pressable>;
        })}
      </View>

      <Text style={[s.label, { color: c.faint }]}>{t('应用图标')}</Text>
      <View accessibilityRole="radiogroup" style={s.inlineGroup}>
        {(['dark', 'light'] as const).map((value) => {
          const selected = iconStyle === value;
          return <Pressable key={value} accessibilityRole="radio" accessibilityLabel={t(value === 'dark' ? '深色图标' : '浅色图标')} accessibilityState={{ selected, checked: selected }} testID={`app-icon-${value}`} onPress={() => { try { Rxd.setAppIcon(value); setIconStyle(value); } catch (failure) { setError(String(failure).replace(/^Error: /, '').slice(0, 500)); } }} style={({ pressed }) => [s.inlineOption, pressed && { opacity: .55 }]}>
            <Text style={[type.list, { color: selected ? c.accent : c.text }]}>{t(value === 'dark' ? '深色图标' : '浅色图标')}</Text>
            {selected && <Icon name="check" size={16} color={c.accent} />}
          </Pressable>;
        })}
      </View>

      <Text style={[s.label, { color: c.faint }]}>{t('动态效果')}</Text>
      <ToggleRow id="motion-reduced" label="减少动态效果" checked={motion === 'reduced'} disabled={!workspace} c={c} action={() => { void perform((core) => core.motion(motion === 'reduced' ? 'system' : 'reduced')); }} />

      <Text style={[s.label, { color: c.faint }]}>{t('文件')}</Text>
      <LimitRow c={c} value={importLimit} disabled={!workspace || pending > 0} action={(bytes) => { void perform(async (core) => { await core.importLimit(bytes); if (alive.current) setImportLimit(core.getSnapshot().importLimit); }); }} />

      <Text style={[s.label, { color: c.faint }]}>{t('安全')}</Text>
      <ToggleRow id="mcp-http-policy" label="允许明文 HTTP（http://）MCP" checked={httpPolicy?.allowPlaintextHttp ?? false} disabled={!workspace?.services || pending > 0} c={c} action={() => { void perform(async (core) => { await core.services!.mcp.setHttpPolicy(!(httpPolicy?.allowPlaintextHttp ?? false)); if (alive.current) setHttpPolicy(core.services!.mcp.httpPolicy()); }); }} />
      {!!httpPolicy?.error && <Text selectable style={[s.error, { color: c.danger }]}>{httpPolicy.error}</Text>}

      <Text style={[s.label, { color: c.faint }]}>{t('Agent')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('系统提示词')} testID="settings-instructions" onPress={() => router.push('/instructions')} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
        <Text style={[type.list, { color: c.text, flex: 1 }]}>{t('系统提示词')}</Text>
        <Text style={[type.micro, { color: instructions.active || instructions.count ? c.accent : c.quiet }]}>{t(instructions.active ? '已选择' : instructions.count ? '{count} 个提示词' : '内置默认', { count: String(instructions.count) })}</Text>
        <Icon name="right" color={c.quiet} size={18} />
      </Pressable>

      <Text style={[s.label, { color: c.faint }]}>{t('工具')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('运行环境')} testID="settings-environment" onPress={() => router.push('/environment')} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
        <Text style={[type.list, { color: c.text, flex: 1 }]}>{t('运行环境')}</Text>
        <Icon name="right" color={c.quiet} size={18} />
      </Pressable>
    </ScrollView>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, header: { minHeight: layout.header, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8 }, back: { width: layout.control, height: layout.control, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  body: { padding: layout.page, paddingBottom: 40 },
  label: { ...type.eyebrow, marginTop: 26, marginBottom: 4 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginHorizontal: -20 },
  checkbox: { width: 20, height: 20, borderWidth: 1, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  inlineGroup: { flexDirection: 'row', alignItems: 'center', gap: 20, minHeight: 44, marginHorizontal: -4 }, inlineOption: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  limitInput: { width: 72, minHeight: 40, paddingHorizontal: 10, textAlign: 'right' },
  error: { ...type.caption, marginBottom: 12 },
});
