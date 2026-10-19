import { useTheme } from './appearance';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Rxd from '../../modules/rxd';
import { useI18n } from '../i18n/index.ts';
import { getAndroidWorkspace } from '../workspace/android';
import type { WorkspaceSnapshot } from '../workspace/core';
import { Icon } from './Icon';
import { ui } from './ServiceUi';
import { type } from './type';

// Query known runtime executables only. Missing packages are reported, not installed.
const CHECK = `set -eu
for tool in bash python node git uv uvx npm npx; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s\\tmissing\\t\\n' "$tool"
  elif version=$("$tool" --version 2>&1); then
    printf '%s\\tready\\t%s\\n' "$tool" "\${version%%$'\\n'*}"
  else
    printf '%s\\terror\\t%s\\n' "$tool" "\${version%%$'\\n'*}"
  fi
done
`;
type ToolStatus = { name: string; state: string; version: string };

export default function EnvironmentScreen() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const locked = useRef(false);
  const autoChecked = useRef(false);
  const { c } = useTheme();
  const busy = snapshot?.conversations.some((conversation) => conversation.busy) ?? false;

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((workspace) => {
      if (!alive.current) return;
      setSnapshot(workspace.getSnapshot());
      unsubscribe = workspace.subscribe(setSnapshot);
    }).catch((failure) => { if (alive.current) setError(String(failure)); });
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);

  const check = useCallback(async () => {
    if (locked.current || busy) return;
    locked.current = true;
    setChecking(true); setError('');
    try {
      const result = await Rxd.runTermux(CHECK, 30000);
      if (result.exitCode !== 0) throw new Error(result.stderr || t('环境检查失败'));
      const found = result.stdout.trim().split('\n').map((line) => {
        const [name, state, ...version] = line.split('\t');
        return { name, state, version: version.join('\t').slice(0, 160) };
      });
      if (found.length !== 8 || found.some((tool, index) => tool.name !== ['bash', 'python', 'node', 'git', 'uv', 'uvx', 'npm', 'npx'][index] || !['missing', 'ready', 'error'].includes(tool.state))) throw new Error(t('环境检查结果不完整'));
      if (alive.current) setTools(found);
    } catch (failure) {
      if (alive.current) { setTools([]); setError(String(failure).replace(/^Error: /, '')); }
    } finally {
      locked.current = false;
      if (alive.current) setChecking(false);
    }
  }, [busy, t]);

  useEffect(() => {
    if (!snapshot || busy || autoChecked.current) return;
    autoChecked.current = true;
    void check();
  }, [snapshot, busy, check]);

  function ask(prompt: string) {
    router.navigate({ pathname: '/', params: { prompt: t(prompt), composeId: globalThis.crypto.randomUUID() } });
  }

  return <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
    <View style={ui.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('返回')} testID="environment-back" onPress={() => router.back()} style={({ pressed }) => [ui.back, pressed && { opacity: .55 }]}><Icon name="back" color={c.quiet} /></Pressable>
      <Text numberOfLines={1} style={[type.heading, { color: c.heading, flex: 1 }]}>{t('运行环境')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('检查环境')} testID="environment-check" disabled={!snapshot || busy || checking} onPress={() => { void check(); }} style={({ pressed }) => [s.check, pressed && { opacity: .55 }, (!snapshot || busy || checking) && { opacity: .35 }]}><Icon name="refresh" color={c.text} size={19} /></Pressable>
    </View>
    <ScrollView contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled">
      {busy && <Text style={[type.caption, { color: c.quiet }]}>{t('任务运行中，结束后可检查环境。')}</Text>}
      {!!error && <Text selectable style={[type.caption, { color: c.danger }]}>{error}</Text>}
      <View style={[s.sectionHead, { marginTop: 22 }]}><Text style={[type.eyebrow, { color: c.faint }]}>{t('已安装工具')}</Text><Text style={[type.caption, { color: c.quiet }]}>{tools.length ? t('{count} 个工具', { count: tools.length }) : t('尚未检查')}</Text></View>
      {!tools.length && <Text style={[type.caption, { color: c.quiet }]}>{t('检查后显示工具与版本')}</Text>}
      {tools.map((tool) => <View key={tool.name} style={s.tool}>
        <Icon name={tool.state === 'ready' ? 'check' : tool.state === 'error' ? 'stop' : 'code'} color={tool.state === 'error' ? c.danger : c.quiet} size={18} />
        <View style={s.meta}><Text style={[type.body, { color: c.text }]}>{tool.name}</Text><Text style={[type.caption, { color: tool.state === 'error' ? c.danger : c.quiet }]}>{tool.state === 'missing' ? t('未安装') : tool.state === 'error' ? t('检查失败') : tool.version || t('版本未知')}</Text></View>
      </View>)}
      <Text style={[type.eyebrow, { color: c.faint, marginTop: 26 }]}>{t('交给 Agent')}</Text>
      {[
        ['检查与诊断', '检查内置运行环境，报告已安装的工具与版本，并诊断发现的问题。先检查，不修改环境。'],
        ['安装工具', '我想安装一个工具。先问我工具名称，再检查当前环境并协助安装和验证。'],
        ['查看空间占用', '查看内置环境和工作区的空间占用，说明哪些是缓存。先报告，不删除文件。'],
      ].map(([label, prompt]) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={t(label)} testID={`environment-ask-${label}`} onPress={() => ask(prompt)} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.wash }]}>
        <Icon name="chat" color={c.accent} size={20} /><Text style={[type.body, { color: c.text }]}>{t(label)}</Text>
      </Pressable>)}
    </ScrollView>
  </SafeAreaView>
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  check: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: -20, paddingHorizontal: 20 },
  meta: { flex: 1, minWidth: 0, gap: 2 },
  tool: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
});
