import { requireVerification } from './access';
import { useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SAMPLE_SOURCE } from '../agent/offline-provider';
import { palettes } from '../ui/theme';
import { type } from '../ui/type';
import { enableCheckpoint, enableShellCheckpoint, openVerificationBridge, publishError, publishShellCount, publishSnapshot } from './bridge';
import type { VerificationSnapshot } from './harness';
import { runPreloadChecks } from './preload';

/**
 * Developer route (`/verify`). The verification scripts drive it with
 * `arxd://verify?action=...`; it runs the same durable runtime the app ships and
 * publishes what really happened through logcat. Not a product screen, so it
 * stays Chinese-only and out of the navigation.
 */
export default function VerificationScreen() {
  const { action, requestId } = useLocalSearchParams<{ action?: string; requestId?: string }>();
  const [snapshot, setSnapshot] = useState<VerificationSnapshot>();
  const [status, setStatus] = useState('正在打开持久会话…');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const started = useRef(false);
  const c = palettes.fire;

  async function preload(bootstrapOnly = false) {
    setBusy(true);
    setError('');
    try {
      const report = await runPreloadChecks(setStatus, bootstrapOnly);
      setStatus(report.verified ? '官方源、Python、Node 与子进程检查通过' : '内置环境启动检查通过');
    } catch (failure) { setError(String(failure)); setStatus('内置环境检查未完成'); }
    finally { setBusy(false); }
  }

  async function operate(stage: 'seed' | 'checkpoint' | 'recover' | 'shell' | 'shell-checkpoint' | 'shell-inspect') {
    setBusy(true);
    setError('');
    try {
      if (stage === 'checkpoint') enableCheckpoint(() => setStatus('检查点已保存。结束 App 进程后重新打开，将继续调用本地 rxd。'));
      if (stage === 'shell-checkpoint') enableShellCheckpoint();
      const harness = await openVerificationBridge();
      if (stage === 'shell-inspect') {
        await publishShellCount();
        setSnapshot(await harness.snapshot());
        setStatus('Shell 执行次数已读取');
        return;
      }
      setStatus(stage === 'recover' ? '正在恢复已保存的任务…' : '正在调用本地 rxd…');
      const result = stage === 'recover'
        ? await harness.resume()
        : stage === 'shell' || stage === 'shell-checkpoint'
          ? await harness.run(requestId ?? 'verify-shell-v1', 'shell')
          : await harness.run(stage === 'seed' ? 'verify-seed-v1' : 'verify-recovery-v1');
      setSnapshot(result);
      setStatus(result.toolErrors ? '会话已保存 · 本地分析失败' : result.toolCount ? '会话已保存 · 本地分析完成' : '持久会话已就绪');
      await publishSnapshot(stage, result);
    } catch (failure) {
      setError(String(failure));
      setStatus('验证未完成');
      await publishError(failure).catch(() => undefined);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    requireVerification();
    if (started.current) return;
    started.current = true;
    if (action === 'preload' || action === 'preload-bootstrap') {
      void Promise.resolve().then(() => preload(action === 'preload-bootstrap'));
      return;
    }
    void Promise.resolve().then(() => operate(action === 'seed' || action === 'checkpoint' || action === 'shell' || action === 'shell-checkpoint' || action === 'shell-inspect' ? action : 'recover'));
    // One storage owner per process. Route/UI unmounts must not open another
    // Harness or treat a React remount as a process-restart verification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={[s.screen, { backgroundColor: c.background }]}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={s.content}>
        <Text style={[s.eyebrow, { color: c.accent }]}>DEVELOPER ROUTE · /VERIFY</Text>
        <Text style={[s.title, { color: c.heading }]}>验证工具</Text>
        <Text style={[s.subtitle, { color: c.quiet }]}>真机验证用，不进入产品导航。</Text>
        <View style={[s.notice, { borderLeftColor: c.accentLine }]}>
          <Text style={[s.noticeTitle, { color: c.text }]}>与应用同一套运行时</Text>
          <Text style={[s.muted, { color: c.quiet }]}>使用固定响应的测试模型，不连接云端模型。会话存储、任务调度和 rxd 分析都真实运行，结果通过 logcat 上报。</Text>
        </View>

        <View style={[s.card, { backgroundColor: c.surface }]}>
          <View style={s.row}>
            {busy && <ActivityIndicator color={c.accent} />}
            <Text testID="verification-status" style={[s.status, { color: c.heading }]}>{status}</Text>
          </View>
          {!!error && <Text selectable style={[s.error, { color: c.danger }]}>{error}</Text>}
          <Text style={[s.label, { color: c.faint }]}>持久会话</Text>
          <Text selectable style={[s.code, { color: c.text }]}>{snapshot?.conversationId ?? '正在读取…'}</Text>
          <View style={s.stats}>
            <Stat label="用户输入" value={snapshot?.userCount ?? 0} />
            <Stat label="已完成回复" value={snapshot?.answerCount ?? 0} />
            <Stat label="Tool results" value={snapshot?.toolCount ?? 0} />
          </View>
          {!!snapshot?.answer && <Text style={[s.answer, { color: c.text }]}>{snapshot.answer}</Text>}
        </View>

        <View style={[s.card, { backgroundColor: c.surface }]}>
          <Text style={[s.label, { color: c.faint }]}>分析样本 · 从不执行</Text>
          <Text selectable style={[s.code, { color: c.text }]}>{SAMPLE_SOURCE}</Text>
          <Text style={[s.muted, { color: c.quiet }]}>查询：rxd js entities · 预期函数 arxdProbe</Text>
          {!!snapshot?.engine && <Text selectable style={[s.engine, { color: c.faint }]}>引擎 {snapshot.engine.engineSha256.slice(0, 16)}…{'\n'}{snapshot.engine.abi} · API {snapshot.engine.sdk} · {snapshot.engine.pageSize} B pages</Text>}
        </View>

        <Action title="运行本地分析" disabled={busy} onPress={() => { void operate('seed'); }} />
        <Action title="通过 Agent 运行脚本" disabled={busy} onPress={() => { void operate('shell'); }} secondary />
        <Action title="准备中断恢复验证" disabled={busy} onPress={() => { void operate('checkpoint'); }} secondary />
        <Action title="验证内置脚本环境" disabled={busy} onPress={() => { void preload(); }} secondary />
        <Text style={[s.footnote, { color: c.faint }]}>中断测试在工具意图提交后暂停。结束进程并重新打开 App，任务会从 SQLite 恢复。重复提交同一验证不会新增输入。</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const c = palettes.fire;
  return <View style={s.stat}><Text style={[s.number, { color: c.heading }]}>{value}</Text><Text style={[s.muted, { color: c.quiet }]}>{label}</Text></View>;
}

function Action({ title, disabled, onPress, secondary = false }: { title: string; disabled: boolean; onPress(): void; secondary?: boolean }) {
  const c = palettes.fire;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress} style={[s.button, { backgroundColor: secondary ? c.surface : c.accent, borderColor: secondary ? c.line : c.accent, borderWidth: secondary ? 1 : 0 }, disabled && s.disabled]}><Text style={[s.buttonText, { color: secondary ? c.text : c.background }]}>{title}</Text></Pressable>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 20, gap: 14 },
  eyebrow: { ...type.eyebrow, marginTop: 8 },
  title: { ...type.display },
  subtitle: { ...type.caption },
  notice: { borderLeftWidth: 2, paddingLeft: 12, gap: 5, marginVertical: 6 },
  noticeTitle: { ...type.label },
  muted: { ...type.caption },
  card: { borderRadius: 14, padding: 16, gap: 10 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  status: { ...type.list, flex: 1 },
  label: { ...type.caption, fontWeight: '600' },
  code: { ...type.code },
  stats: { flexDirection: 'row', gap: 18, marginVertical: 2 },
  stat: { flex: 1 },
  number: { ...type.title },
  answer: { ...type.body },
  engine: { ...type.mono, fontSize: 11, lineHeight: 18 },
  button: { borderRadius: 12, padding: 15, alignItems: 'center' },
  disabled: { opacity: 0.45 },
  buttonText: { ...type.label, fontWeight: '600', fontSize: 15 },
  footnote: { ...type.micro, lineHeight: 18, marginBottom: 20 },
  error: { ...type.caption },
});
