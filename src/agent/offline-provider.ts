import { Type } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { tr } from '../i18n/base.ts';
import type { EngineInfo, RxdResult } from '../../modules/rxd/index.ts';
import { SHELL_PROBE } from './shell.ts';
import { skillVerificationResponse } from '../verification/skill-provider.ts';
import { capacityVerificationResponse } from '../verification/capacity-provider.ts';
import type { SkillHost } from '../workspace/skills.ts';

export const SAMPLE_SOURCE = 'export function arxdProbe(value) { return value + 1; }\n';
export const SAMPLE_SHA256 = 'd0e6da49d8dbff1ccfd185d4536cc6e3437eb83270570d6ca0b45699001d9c21';

export type RxdInput = { source: string; inputSha256: string; engineSha256: string };

/** The trusted, deterministic part of the verification runtime. */
export type OfflineHost = {
  /** Trusted deterministic provider boundary for native verification; never applied to live models. */
  offlineResponse?: (...args: Parameters<FauxResponseFactory>) => ReturnType<FauxResponseFactory> | undefined | Promise<Awaited<ReturnType<FauxResponseFactory>> | undefined>;
  info: EngineInfo;
  run(input: RxdInput): Promise<RxdResult>;
  checkpoint?(context: { abortSignal?: AbortSignal }): Promise<void>;
  skills?: SkillHost;
};

/**
 * Build the offline response provider used by native verification and the
 * fixed test model. This is intentionally separate from the live Harness
 * runtime so production setup does not own test fixtures.
 */
export function createOfflineProvider(host: OfflineHost) {
  const provider = fauxProvider({ api: 'arxd-offline-v1' });
  // Context-based responses survive a fresh process. Only the provider is
  // deterministic: Pi's scheduler, durable storage and rxd execution are real.
  const respond: FauxResponseFactory = async (context, options, state, model) => {
    provider.appendResponses([respond]);
    const supplied = await host.offlineResponse?.(context, options, state, model);
    if (supplied) return supplied;
    const capacityProbe = await capacityVerificationResponse(context, options?.signal);
    if (capacityProbe) return capacityProbe;
    // Pi 1.3's summarizer is a separate, tool-free request. Keep this provider explicit.
    if (context.messages.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('You are a context summarization assistant.'))) {
      return fauxAssistantMessage(fauxText('Offline test compaction: this is a deterministic test summary, not a live model summary. Original entries remain in storage.'));
    }
    // Installing a new tool on an existing conversation appends a system
    // update after the user entry. Select the last conversational message.
    const skillProbe = await skillVerificationResponse(context);
    if (skillProbe) return skillProbe;
    const last = context.messages.filter((message) => message.role !== 'system').at(-1);
    if (last?.role === 'toolResult') {
      if (last.toolName.startsWith('skill_')) return fauxAssistantMessage(fauxText(last.isError ? tr('技能工具失败，错误记录已保存。') : tr('测试模型已读取技能内容；不会自动运行脚本。这不是实时模型的推理结果。')));
      if (!last.isError && last.toolName === 'rxd_file_outline') {
        const records = last.content.filter((part) => part.type === 'text').flatMap((part) => {
          try { return part.text.trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; }
        });
        const entities = records.filter((r) => r?.record === 'entity');
        const names = entities.map((r) => r.detail?.name).filter((n): n is string => typeof n === 'string');
        return fauxAssistantMessage(fauxText(tr('本地 rxd 已完成真实 JavaScript 结构查询，返回 {count} 个实体。{names}\n\n可以打开下方证据记录核对，或导出本次结果。当前使用固定测试模型，这段说明仅依据工具返回的结构生成。', { count: entities.length, names: names.length ? tr('\n\n可导航名称：{list}。', { list: names.slice(0, 12).join(tr('、')) }) : '' })));
      }
      return fauxAssistantMessage(fauxText(last.isError
        ? tr('本地工具失败或已中断；错误结果已保存。')
        : last.toolName === 'shell' ? tr('本地脚本已执行，实际输出与退出状态已保存。')
        : tr('本地 rxd 已完成真实 JavaScript 结构分析，结果已保存。')));
    }
    const userText = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')) : '';
    const selectedSkill = /<arxd-skill id="([a-f0-9-]{36})" version="([a-f0-9]{64})"\/>/.exec(userText);
    if (selectedSkill && host.skills) return fauxAssistantMessage(fauxToolCall('skill_load', { id: selectedSkill[1], version: selectedSkill[2] }, { id: `skill-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
    if (userText.includes('<arxd-workspace>')) {
      const capture = /<arxd-file id="([a-f0-9-]+)" sha256="([a-f0-9]{64})" engine="([a-f0-9]{64})"[^>]*supported="([01])"\/>/.exec(userText);
      if (capture) {
        if (capture[4] === '0') return fauxAssistantMessage(fauxText(tr('文件已保存在当前对话。可用本地 rxd 的 rxd_file_outline 快速查询 4 KiB 内 UTF-8 JavaScript，其他格式可通过 shell 运行 $ARXD_RXD 分析。')));
        return fauxAssistantMessage(fauxToolCall('rxd_file_outline', { fileId: capture[1], inputSha256: capture[2], engineSha256: capture[3] }, { id: `file-${context.messages.filter((m) => m.role === 'user').length}` }), { stopReason: 'toolUse' });
      }
      if (!/脚本环境|shell|python|node/i.test(userText.split('\n\n<arxd-workspace>')[0])) {
        return fauxAssistantMessage(fauxText(tr('问题已保存在对话中。当前使用固定测试模型：可以添加文件并选择内置样本，通过本地 rxd 查看真实结构结果；也可以运行脚本环境检查。')));
      }
      const script = userText.startsWith('运行 Shell 停止验证') ? 'printf "Arxd cancellation probe started\\n"; sleep 30; printf "probe completed\\n"' : SHELL_PROBE;
      return fauxAssistantMessage(fauxToolCall('shell', { script, timeoutMs: 60000 }, { id: `shell-${context.messages.filter((m) => m.role === 'user').length}` }), { stopReason: 'toolUse' });
    }
    if (last?.role === 'user' && JSON.stringify(last.content).includes('脚本环境')) {
      return fauxAssistantMessage(fauxToolCall('shell', { script: SHELL_PROBE, timeoutMs: 60000 },
        { id: `shell-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('rxd_sample_outline', {
      source: SAMPLE_SOURCE,
      inputSha256: SAMPLE_SHA256,
      engineSha256: host.info.engineSha256,
    }, { id: `rxd-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
  };
  provider.setResponses([respond]);
  return provider;
}

/** Register fixtures that are only meaningful with the deterministic provider. */
export function offlineExtension(host: OfflineHost) {
  return defineExtension({
    name: 'arxd-offline',
    tools: [defineTool({
      name: 'rxd_sample_outline',
      description: 'Run the installed rxd JS outline query on an immutable, bounded source capture.',
      parameters: Type.Object({
        source: Type.String({ maxLength: 4096 }),
        inputSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        engineSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      }),
      replay: 'safe',
      outputLimits: { maxBytes: 32768, maxLines: 128, retain: 'head' },
      execute: async (input, _api, context) => {
        // This deliberate test gate is reached after Pi commits tool intent.
        // It lets a device/process kill test interrupt a real pending task.
        await host.checkpoint?.(context);
        if (context.abortSignal?.aborted) throw new Error('rxd task cancelled before execution');
        const result = await host.run(input);
        if (result.exitCode !== 0) throw new Error(`rxd exit ${result.exitCode}: ${result.stderr}`);
        if (result.inputSha256 !== input.inputSha256 || result.engineSha256 !== input.engineSha256) {
          throw new Error('rxd capture or engine identity changed');
        }
        const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
        if (!records.some((record) => record.record === 'entity' && record.detail?.name === 'arxdProbe')) {
          throw new Error('rxd did not return the expected sample function');
        }
        return {
          output: [{ type: 'text', text: result.stdout }],
          details: {
            stderr: result.stderr, exitCode: result.exitCode,
            inputSha256: result.inputSha256, engineSha256: result.engineSha256,
            durationMs: result.durationMs, recordCount: records.length,
          },
        };
      },
    })],
  });
}
