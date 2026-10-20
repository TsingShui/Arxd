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
    try { await core.prompts.select(scope, id); await reload(); setNotice(t("Prompt selected")); }
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
      setNotice(t("Prompt saved"));
    } catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { setSaving(false); }
  }
  function remove(profile: PromptProfile) {
    if (!core) return;
    Alert.alert(t("Delete prompt {name}?", { name: profile.name }), t("This cannot be undone; models using it return to the built-in default."), [
      { text: t("Cancel"), style: 'cancel' },
      { text: t("Delete"), style: 'destructive', onPress: () => { void (async () => {
        if (!core) return;
        setSaving(true); setError(''); setNotice('');
        try { await core.prompts.remove(profile.id); await reload(); setNotice(t("Prompt deleted")); }
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
        <Pressable accessibilityRole="button" accessibilityLabel={t("Back")} onPress={() => { if (draft) { setDraft(undefined); setError(''); setNotice(''); } else router.back(); }} style={({ pressed }) => [s.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
        <Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t(draft ? 'Edit prompt (2)' : 'System prompt (2)')}</Text>
        {(saving || !data) && <BusyIndicator color={c.accent} />}
        {draft && <Pressable accessibilityRole="button" accessibilityLabel={t("Save prompt")} testID="instructions-save" disabled={saving} onPress={() => { void saveDraft(); }} style={({ pressed }) => [s.save, { borderColor: c.line }, pressed && { opacity: .55 }, saving && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t("Save")}</Text></Pressable>}
      </View>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {!!error && <Text selectable style={[type.caption, { color: c.danger }]}>{t(error)}</Text>}
        {!!notice && <Text style={[type.caption, { color: c.contextMedium }]}>{t(notice)}</Text>}
        {draft ? <>
          <Text style={[type.label, { color: c.heading }]}>{t("Prompt name")}</Text>
          <TextInput accessibilityLabel={t("Prompt name")} value={draft.name} onChangeText={(name) => setDraft((current) => current ? { ...current, name } : current)} maxLength={60} placeholder={t("For example: concise analysis")} placeholderTextColor={c.faint} style={[s.name, { color: c.text, backgroundColor: c.raised, borderColor: c.line }]} />
          <View style={s.editorMeta}><Text style={[type.label, { color: c.heading }]}>{t("Prompt content")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("Fill with built-in default")} onPress={resetToDefault} style={({ pressed }) => [s.link, pressed && { opacity: .55 }]}><Text style={[type.micro, { color: c.accent }]}>{t("Fill with built-in default")}</Text></Pressable></View>
          <TextInput accessibilityLabel={t("Prompt content")} testID="instructions-input" value={draft.text} onChangeText={(text) => setDraft((current) => current ? { ...current, text } : current)} editable={!saving} multiline autoCapitalize="none" autoCorrect={false} maxLength={INSTRUCTION_LIMIT} placeholder={t("Write your system prompt…")} placeholderTextColor={c.faint} style={[s.input, { color: c.text, backgroundColor: c.code, borderColor: c.line }]} />
          <Text style={[type.micro, { color: c.quiet }]}>{draft.text.length} / {INSTRUCTION_LIMIT}</Text>
          <View style={[s.note, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="brain" color={c.accent} size={18} /><Text style={[type.caption, { color: c.quiet, flex: 1 }]}>{t("Host safety rules remain at the top; removing tool, file-marker or shell instructions can break analysis.")}</Text></View>
        </> : <>
          <View style={s.tabs} accessibilityRole="tablist">
            {(['cloud', 'local'] as Scope[]).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: scope === item }} onPress={() => { setScope(item); setNotice(''); setError(''); }} style={[s.tab, { borderColor: scope === item ? c.accent : c.line, backgroundColor: scope === item ? c.wash : c.surface }]}><Text style={[type.label, { color: scope === item ? c.accent : c.text, flex: 1 }]}>{t(item === 'cloud' ? 'Cloud model' : 'Local models')}</Text><Text style={[type.micro, { color: c.quiet }]}>{t(data?.active[item] ? 'Selected' : 'Built-in default')}</Text></Pressable>)}
          </View>
          <View style={[s.note, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="brain" color={c.accent} size={18} /><Text style={[type.caption, { color: c.quiet, flex: 1 }]}>{t("The prompt is sent to the model provider; host safety rules remain. Selecting it affects all conversations and applies to the next request.")}</Text></View>
          <Text style={[type.eyebrow, { color: c.faint }]}>{t("Saved prompts")}</Text>
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: active === null }} onPress={() => { void select(null); }} disabled={saving} style={({ pressed }) => [s.profile, { borderColor: active === null ? c.accent : c.line, backgroundColor: active === null ? c.wash : c.surface }, pressed && { opacity: .65 }]}>
            <View style={s.profileMain}><Text style={[type.list, { color: c.heading }]}>{t("Built-in default")}</Text><Text numberOfLines={2} style={[type.micro, { color: c.quiet }]}>{t("Arxd built-in prompt; read-only")}</Text></View>
            <View style={[s.check, { borderColor: active === null ? c.accent : c.line, backgroundColor: active === null ? c.accent : 'transparent' }]}>{active === null && <Icon name="check" color={c.onAccent} size={14} />}</View>
          </Pressable>
          {profiles.map((profile) => <View key={profile.id} style={[s.profile, { borderColor: active === profile.id ? c.accent : c.line, backgroundColor: active === profile.id ? c.wash : c.surface }]}>
            <Pressable accessibilityRole="radio" accessibilityState={{ checked: active === profile.id }} onPress={() => { void select(profile.id); }} disabled={saving} style={({ pressed }) => [s.profileMain, pressed && { opacity: .65 }]}>
              <Text numberOfLines={1} style={[type.list, { color: c.heading }]}>{profile.name}</Text>
              <Text numberOfLines={2} style={[type.micro, { color: c.quiet }]}>{profile.text.replace(/\s+/g, ' ').slice(0, 120)}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t("Edit {name}", { name: profile.name })} onPress={() => startEdit(profile)} style={({ pressed }) => [s.icon, pressed && { opacity: .55 }]}><Icon name="edit" color={c.quiet} size={17} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t("Delete {name}", { name: profile.name })} onPress={() => remove(profile)} style={({ pressed }) => [s.icon, pressed && { opacity: .55 }]}><Icon name="trash" color={c.danger} size={17} /></Pressable>
            <View style={[s.check, { borderColor: active === profile.id ? c.accent : c.line, backgroundColor: active === profile.id ? c.accent : 'transparent' }]}>{active === profile.id && <Icon name="check" color={c.onAccent} size={14} />}</View>
          </View>)}
          {!profiles.length && <Text style={[type.caption, { color: c.quiet }]}>{t("No custom prompts yet.")}</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel={t("New prompt")} testID="instructions-new" onPress={startNew} style={({ pressed }) => [s.newButton, { borderColor: c.line }, pressed && { opacity: .55 }]}><Icon name="plus" color={c.accent} size={18} /><Text style={[type.label, { color: c.accent }]}>{t("New prompt")}</Text></Pressable>
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
