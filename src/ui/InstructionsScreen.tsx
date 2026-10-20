import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { INSTRUCTION_LIMIT } from '../agent/instructions';
import { useI18n } from '../i18n';
import { getAndroidWorkspace } from '../workspace/android';
import type { PromptProfile, Workspace } from '../workspace/core';
import { useTheme } from './appearance';
import { BusyIndicator } from './BusyIndicator';
import { Icon } from './Icon';
import { layout } from './theme';
import { type } from './type';

type Scope = 'cloud' | 'local';
type State = {
  profiles: PromptProfile[];
  active: { cloud: string | null; local: string | null };
  defaults: { cloud: string; local: string };
};
type Draft = { id?: string; name: string; text: string };

export function InstructionsScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const [core, setCore] = useState<Workspace>();
  const [data, setData] = useState<State>();
  const [scope, setScope] = useState<Scope>('cloud');
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    void getAndroidWorkspace().then(async (workspace) => {
      const loaded = await workspace.prompts.get();
      if (!live) return;
      setCore(workspace); setData(loaded);
    }).catch((failure) => { if (live) setError(String(failure).replace(/^Error: /, '')); });
    return () => { live = false; };
  }, []);

  async function reload() {
    if (!core) return;
    setData(await core.prompts.get());
  }
  async function select(id: string | null) {
    if (!core || saving) return;
    setSaving(true); setError(''); setNotice('');
    try { await core.prompts.select(scope, id); await reload(); setNotice(t('已选择提示词')); }
    catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { setSaving(false); }
  }
  function startNew() {
    setDraft({ name: '', text: '' });
    setNotice(''); setError('');
  }
  function startEdit(profile: PromptProfile) {
    setDraft({ id: profile.id, name: profile.name, text: profile.text });
    setNotice(''); setError('');
  }
  async function saveDraft() {
    if (!core || !draft || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await core.prompts.save({ id: draft.id, name: draft.name, text: draft.text, scope, activate: !draft.id });
      await reload();
      setDraft(undefined);
      setNotice(t('提示词已保存'));
    } catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { setSaving(false); }
  }
  function remove(profile: PromptProfile) {
    if (!core) return;
    Alert.alert(t('删除提示词 {name}？', { name: profile.name }), t('删除后无法恢复；当前使用它的模型会回到内置默认。'), [
      { text: t('取消'), style: 'cancel' },
      { text: t('删除'), style: 'destructive', onPress: () => { void (async () => {
        if (!core) return;
        setSaving(true); setError(''); setNotice('');
        try { await core.prompts.remove(profile.id); await reload(); setNotice(t('提示词已删除')); }
        catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
        finally { setSaving(false); }
      })(); } },
    ]);
  }
  function resetToDefault() {
    if (!draft || !data) return;
    setDraft({ ...draft, text: data.defaults[scope] });
  }

  const active = data?.active[scope] ?? null;
  const profiles = data?.profiles ?? [];
  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.screen}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('返回')} onPress={() => { if (draft) { setDraft(undefined); setError(''); setNotice(''); } else router.back(); }} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
        <Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t(draft ? '编辑提示词' : '系统提示词')}</Text>
        {(saving || !data) && <BusyIndicator color={c.accent} />}
        {draft && <Pressable accessibilityRole="button" accessibilityLabel={t('保存提示词')} testID="instructions-save" disabled={saving} onPress={() => { void saveDraft(); }} style={({ pressed }) => [s.save, { borderColor: c.line }, pressed && { opacity: .55 }, saving && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t('保存')}</Text></Pressable>}
      </View>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {!!error && <Text selectable style={[type.caption, { color: c.danger }]}>{error}</Text>}
        {!!notice && <Text style={[type.caption, { color: c.contextMedium }]}>{notice}</Text>}
        {draft ? <>
          <Text style={[type.label, { color: c.heading }]}>{t('提示词名称')}</Text>
          <TextInput accessibilityLabel={t('提示词名称')} value={draft.name} onChangeText={(name) => setDraft((current) => current ? { ...current, name } : current)} maxLength={60} placeholder={t('例如：简洁分析')} placeholderTextColor={c.faint} style={[s.name, { color: c.text, backgroundColor: c.raised, borderColor: c.line }]} />
          <View style={s.editorMeta}><Text style={[type.label, { color: c.heading }]}>{t('提示词内容')}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('填入内置默认')} onPress={resetToDefault} style={({ pressed }) => [s.link, pressed && { opacity: .55 }]}><Text style={[type.micro, { color: c.accent }]}>{t('填入内置默认')}</Text></Pressable></View>
          <TextInput accessibilityLabel={t('提示词内容')} testID="instructions-input" value={draft.text} onChangeText={(text) => setDraft((current) => current ? { ...current, text } : current)} editable={!saving} multiline autoCapitalize="none" autoCorrect={false} maxLength={INSTRUCTION_LIMIT} placeholder={t('写你的系统提示词…')} placeholderTextColor={c.faint} style={[s.input, { color: c.text, backgroundColor: c.code, borderColor: c.line }]} />
          <Text style={[type.micro, { color: c.quiet }]}>{draft.text.length} / {INSTRUCTION_LIMIT}</Text>
          <View style={[s.note, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="brain" color={c.accent} size={18} /><Text style={[type.caption, { color: c.quiet, flex: 1 }]}>{t('宿主安全规则仍会保留在最前面；删掉工具、文件标记或 shell 说明可能导致分析失败。')}</Text></View>
        </> : <>
          <View style={s.tabs} accessibilityRole="tablist">
            {(['cloud', 'local'] as Scope[]).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: scope === item }} onPress={() => { setScope(item); setNotice(''); setError(''); }} style={[s.tab, { borderColor: scope === item ? c.accent : c.line, backgroundColor: scope === item ? c.wash : c.surface }]}><Text style={[type.label, { color: scope === item ? c.accent : c.text, flex: 1 }]}>{t(item === 'cloud' ? '普通模型' : '端侧模型')}</Text><Text style={[type.micro, { color: c.quiet }]}>{t(data?.active[item] ? '已选择' : '内置默认')}</Text></Pressable>)}
          </View>
          <View style={[s.note, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="brain" color={c.accent} size={18} /><Text style={[type.caption, { color: c.quiet, flex: 1 }]}>{t('提示词会发送给模型提供商；宿主安全规则始终保留。选择后影响当前所有对话，下一次请求生效。')}</Text></View>
          <Text style={[type.eyebrow, { color: c.faint }]}>{t('已保存的提示词')}</Text>
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: active === null }} onPress={() => { void select(null); }} disabled={saving} style={({ pressed }) => [s.profile, { borderColor: active === null ? c.accent : c.line, backgroundColor: active === null ? c.wash : c.surface }, pressed && { opacity: .65 }]}>
            <View style={s.profileMain}><Text style={[type.list, { color: c.heading }]}>{t('内置默认')}</Text><Text numberOfLines={2} style={[type.micro, { color: c.quiet }]}>{t('Arxd 内置提示词，不可编辑')}</Text></View>
            <View style={[s.check, { borderColor: active === null ? c.accent : c.line, backgroundColor: active === null ? c.accent : 'transparent' }]}>{active === null && <Icon name="check" color={c.onAccent} size={14} />}</View>
          </Pressable>
          {profiles.map((profile) => <View key={profile.id} style={[s.profile, { borderColor: active === profile.id ? c.accent : c.line, backgroundColor: active === profile.id ? c.wash : c.surface }]}>
            <Pressable accessibilityRole="radio" accessibilityState={{ checked: active === profile.id }} onPress={() => { void select(profile.id); }} disabled={saving} style={({ pressed }) => [s.profileMain, pressed && { opacity: .65 }]}>
              <Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{profile.name}</Text>
              <Text numberOfLines={2} style={[type.micro, { color: c.quiet }]}>{profile.text.replace(/\s+/g, ' ').slice(0, 120)}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('编辑 {name}', { name: profile.name })} onPress={() => startEdit(profile)} style={({ pressed }) => [s.icon, pressed && { opacity: .55 }]}><Icon name="edit" color={c.quiet} size={17} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('删除 {name}', { name: profile.name })} onPress={() => remove(profile)} style={({ pressed }) => [s.icon, pressed && { opacity: .55 }]}><Icon name="trash" color={c.danger} size={17} /></Pressable>
            <View style={[s.check, { borderColor: active === profile.id ? c.accent : c.line, backgroundColor: active === profile.id ? c.accent : 'transparent' }]}>{active === profile.id && <Icon name="check" color={c.onAccent} size={14} />}</View>
          </View>)}
          {!profiles.length && <Text style={[type.caption, { color: c.quiet }]}>{t('还没有自定义提示词。')}</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel={t('新建提示词')} testID="instructions-new" onPress={startNew} style={({ pressed }) => [s.newButton, { borderColor: c.line }, pressed && { opacity: .55 }]}><Icon name="plus" color={c.accent} size={18} /><Text style={[type.label, { color: c.accent }]}>{t('新建提示词')}</Text></Pressable>
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  header: { minHeight: layout.header, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 },
  back: { width: layout.control, height: layout.control, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  save: { minHeight: 38, borderWidth: 1, borderRadius: 19, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  body: { padding: layout.page, paddingBottom: 40, gap: 12 },
  tabs: { flexDirection: 'row', gap: 10 },
  tab: { flex: 1, minHeight: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12 },
  profile: { minHeight: 68, borderWidth: 1, borderRadius: 12, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileMain: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 3, paddingVertical: 8 },
  icon: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  check: { width: 20, height: 20, borderWidth: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  newButton: { minHeight: 48, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  name: { minHeight: 46, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, ...type.body },
  editorMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { minHeight: 40, justifyContent: 'center' },
  input: { minHeight: 360, borderWidth: 1, borderRadius: 12, padding: 14, textAlignVertical: 'top', ...type.body, lineHeight: 22 },
});
