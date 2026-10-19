import { BusyIndicator } from './BusyIndicator';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../i18n/index.ts';
import type { ToolView, TurnView } from '../workspace/core';
import { Icon, type IconName } from './Icon';
import { RichText } from './RichText';
import type { Colors } from './theme';
import { type } from './type';
import { toolLabel } from './tool-label';

export function ResponseActivity({ turn, c, onTool, onCopy, onShare, onRegenerate, onContinue, caret }: {
  turn: TurnView; c: Colors; onTool: (tool: ToolView) => void;
  onCopy?: () => void; onShare?: () => void; onRegenerate?: () => void; onContinue?: () => void;
  caret?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>();
  const [blocks, setBlocks] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now);
  const running = turn.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  const duration = (milliseconds: number | undefined) => milliseconds === undefined ? t('耗时未记录')
    : t('{seconds} 秒', { seconds: (Math.max(0, milliseconds) / 1000).toFixed(milliseconds < 10000 ? 1 : 0) });
  const timing = (key: string, fallback?: number) => {
    const phase = turn.timing?.phases.findLast((phase) => phase.key === key);
    return duration(fallback ?? (phase?.state === 'running' ? now - phase.startedAt : phase?.durationMs));
  };
  const phaseLabel = turn.phase === 'recovery' ? t('网络恢复中') : turn.phase === 'thinking' ? t('思考中') : turn.phase === 'tool' ? t('正在调用本地工具')
    : turn.phase === 'answer' ? t('正在生成回答') : turn.phase === 'preparing' ? t('正在准备工具调用') : t('等待响应');
  const stateLabel = running ? phaseLabel : turn.status === 'done' ? t('已完成') : turn.status === 'failed' ? t('未完成') : t('已停止');
  const elapsed = running ? Math.max(0, now - turn.startedAt) : turn.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt;
  const controls = turn.activities.filter((block) => block.kind === 'thinking' || block.kind === 'tool');
  const expanded = open ?? running;
  const lastText = turn.activities.findLast((block) => block.kind === 'text')?.id;
  const toggle = (id: string) => setBlocks((value) => ({ ...value, [id]: !value[id] }));
  // A plain completed answer needs no status chrome; tool/thinking turns collapse
  // into one process line so the transcript reads like a conversation, not a log.
  const steps = controls.length;
  const errors = turn.activities.filter((block) => block.kind === 'request-error');
  const hasProcess = steps > 0 || errors.length > 0;
  const processLabel = running ? phaseLabel
    : errors.length ? `${stateLabel} · ${t('{count} 次请求失败', { count: errors.length })}`
    : turn.status === 'done' ? t('{count} 个步骤', { count: steps })
    : `${stateLabel} · ${t('{count} 个步骤', { count: steps })}`;
  const showHeading = !hasProcess && (running || turn.status !== 'done');
  const action = (icon: IconName, label: string, onPress: () => void, testID: string) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} onPress={onPress} style={({ pressed }) => [s.action, pressed && { opacity: .55 }]}>
      <Icon name={icon} color={c.quiet} size={15} /><Text style={[type.micro, { color: c.quiet }]}>{label}</Text>
    </Pressable>;
  const hasAnswer = !!turn.answer.trim();
  return <View>
    {showHeading && <View style={s.heading} testID={`turn-status-${turn.id}`}>
      {running ? <BusyIndicator size="small" color={c.accent} /> : <Icon name={turn.status === 'done' ? 'check' : 'stop'} color={turn.status === 'failed' ? c.danger : c.quiet} size={14} />}
      <Text style={[type.caption, { color: c.quiet }]}>{stateLabel} · {t('历时 {duration}', { duration: duration(elapsed) })}</Text>
    </View>}
    {running && turn.recovery && <View testID="request-network-recovery" style={[s.block, { borderColor: c.accent }]}>
      <Text accessibilityLiveRegion="polite" style={[type.caption, { color: c.accent }]}>{t('网络重试 {attempt}/3 · {seconds} 秒后尝试', { attempt: turn.recovery.attempt, seconds: Math.max(0, Math.ceil((turn.recovery.at - now) / 1000)) })}</Text>
      <Text selectable style={[s.note, { color: c.quiet }]}>{turn.recovery.error}</Text>
    </View>}
    {hasProcess && <Pressable accessibilityRole="button" accessibilityLabel={t(expanded ? '收起执行过程' : '展开执行过程')} accessibilityState={{ expanded }} onPress={() => setOpen(!expanded)} style={s.summary}>
      {running ? <BusyIndicator size="small" color={c.accent} /> : <Icon name={turn.status === 'done' ? 'check' : 'stop'} color={turn.status === 'failed' || errors.length ? c.danger : c.quiet} size={14} />}
      <Text style={[type.caption, { color: c.quiet, flex: 1 }]}>{processLabel}</Text>
      {elapsed !== undefined && <Text style={[type.micro, { color: c.faint }]}>{duration(elapsed)}</Text>}
      <View style={expanded ? s.rotated : undefined}><Icon name="chevron" color={c.quiet} size={14} /></View>
    </Pressable>}
    {turn.timing?.incomplete && <Text style={[s.note, { color: c.quiet }]}>{t('已恢复；中断前的部分阶段没有完整计时。')}</Text>}
    {turn.timing?.truncated && <Text style={[s.note, { color: c.quiet }]}>{t('部分阶段计时超出记录上限；原始消息和工具结果仍保留。')}</Text>}
    {turn.activities.map((block) => {
      if (block.kind === 'text') return !!block.text && <RichText key={block.id} content={block.text} c={c} caret={block.id === lastText ? caret : undefined} />;
      if (!expanded) return null;
      if (block.kind === 'request-error') return <View key={block.id} testID="request-error" style={[s.block, { borderColor: c.danger }]}>
        <Text style={[type.caption, { color: c.danger }]}>{t('请求 {attempt}/4 · {category}', { attempt: block.failure.attempt, category: block.failure.category })}{block.partial ? ` · ${t('本次输出不完整')}` : ''}</Text>
        <Text selectable style={[s.note, { color: c.danger }]}>{block.failure.message}</Text>
      </View>;
      if (block.kind === 'thinking') return <View key={block.id} style={[s.block, { borderColor: c.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t(blocks[block.id] ? '收起思考内容' : '展开思考内容')} accessibilityState={{ expanded: !!blocks[block.id], disabled: !block.text }} disabled={!block.text} onPress={() => toggle(block.id)} style={s.row}>
          {block.live ? <BusyIndicator size="small" color={c.accent} /> : <Icon name="spark" color={c.quiet} size={17} />}
          <Text style={[type.caption, { color: c.text, flex: 1 }]}>{t(block.live ? '思考中' : turn.timing?.phases.findLast((phase) => phase.key === block.timingKey)?.state === 'interrupted' ? '思考已中断' : '已思考')}</Text>
          <Text style={[type.micro, { color: c.quiet }]}>{timing(block.timingKey)}</Text>
          {!!block.text && <View style={blocks[block.id] ? s.rotated : undefined}><Icon name="chevron" color={c.quiet} size={14} /></View>}
        </Pressable>
        {blocks[block.id] && !!block.text && <Text selectable style={[s.thinking, { color: c.quiet }]}>{block.text.slice(0, 32768)}{block.text.length > 32768 ? t('\n（思考预览已截断，原始内容仍保留）') : ''}</Text>}
      </View>;
      const name = toolLabel(block.name, block.result?.details);
      const state = block.state === 'pending' ? t('等待执行') : block.state === 'running' ? t('运行中') : block.state === 'done' ? t('完成') : block.state === 'stopped' ? t('已停止') : t('失败或中断');
      const args = JSON.stringify(block.arguments, null, 2);
      return <View key={block.id} testID={`tool-activity-${block.callId}`} style={[s.block, { borderColor: c.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('工具 {name} · {state}', { name, state })} accessibilityState={{ expanded: !!blocks[block.id] }} onPress={() => toggle(block.id)} style={s.row}>
          {block.state === 'running' ? <BusyIndicator size="small" color={c.accent} /> : <Icon name={block.state === 'done' ? 'check' : block.state === 'error' || block.state === 'stopped' ? 'stop' : 'code'} color={block.state === 'error' ? c.danger : c.quiet} size={17} />}
          <View style={{ flex: 1 }}><Text style={[type.list, { color: c.text }]}>{name}</Text><Text style={[type.micro, { color: c.quiet }]}>{state}{turn.file && block.name.startsWith('rxd_') ? ` · ${turn.file.name}` : ''}</Text></View>
          <Text style={[type.micro, { color: c.quiet }]}>{block.state === 'pending' ? '' : timing(block.timingKey, block.result?.durationMs)}</Text>
          <View style={blocks[block.id] ? s.rotated : undefined}><Icon name="chevron" color={c.quiet} size={14} /></View>
        </Pressable>
        {blocks[block.id] && <View style={s.details}>
          <Text style={[s.note, { color: c.quiet }]}>{t('调用参数')}</Text>
          <Text selectable style={[type.code, { color: c.text }]}>{args.slice(0, 8192)}{args.length > 8192 ? t('\n（参数预览已截断）') : ''}</Text>
          {!block.result && !!block.output && <Text selectable style={[type.code, { color: c.quiet, marginTop: 12 }]}>{block.output.slice(-1200)}</Text>}
          {block.result && <><Text style={[s.note, { color: c.quiet }]}>{t('工具输出')}</Text><Text selectable style={[type.code, { color: block.result.isError ? c.danger : c.text }]}>{block.result.text.slice(0, 1200)}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('查看{name}输出', { name })} onPress={() => onTool(block.result!)} style={s.full}><Text style={[type.label, { color: c.accent }]}>{t('查看完整工具记录')}</Text><Icon name="right" color={c.accent} size={16} /></Pressable>
          </>}
        </View>}
      </View>;
    })}
    {!turn.activities.some((block) => block.kind === 'text' && block.text) && !!turn.answer && <RichText content={turn.answer} c={c} caret={caret} />}
    {turn.status === 'stopped' && !turn.answer && <Text style={[s.thinking, { color: c.quiet }]}>{t('本次分析已停止或中断，已保留当前对话。可以继续补充问题。')}</Text>}
    {!running && (onCopy || onShare || onRegenerate || onContinue) && (hasAnswer || turn.status !== 'done') && <View style={s.actions}>
      {hasAnswer && onCopy && action('copy', t('复制回答'), onCopy, `turn-copy-${turn.id}`)}
      {hasAnswer && onShare && action('share', t('分享回答'), onShare, `turn-share-${turn.id}`)}
      {turn.status === 'failed' && onRegenerate && action('refresh', t('重试'), onRegenerate, `turn-retry-${turn.id}`)}
      {turn.status === 'done' && hasAnswer && onRegenerate && action('refresh', t('重新生成'), onRegenerate, `turn-regenerate-${turn.id}`)}
      {turn.status === 'stopped' && onContinue && action('arrow', t('继续'), onContinue, `turn-continue-${turn.id}`)}
    </View>}
  </View>;
}

const s = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 26, marginBottom: 10 },
  summary: { flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 8, marginBottom: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 2, marginBottom: 16, marginLeft: -8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 8 },
  block: { borderLeftWidth: 1, paddingLeft: 12, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44 },
  note: { ...type.micro, marginTop: 8, marginBottom: 8 },
  thinking: { ...type.caption, paddingVertical: 10, lineHeight: 22 },
  details: { paddingVertical: 8, paddingRight: 8 },
  full: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 8 },
  rotated: { transform: [{ rotate: '180deg' }] },
});
