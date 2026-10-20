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
      if (last.toolName.startsWith('skill_')) return fauxAssistantMessage(fauxText(last.isError ? tr("The skill tool failed; the error record is saved.") : tr("The test model read the skill content and will not run scripts automatically. This is not a live model reasoning result.")));
      if (!last.isError && last.toolName === 'rxd_file_outline') {
        const records = last.content.filter((part) => part.type === 'text').flatMap((part) => {
          try { return part.text.trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; }
        });
        const entities = records.filter((r) => r?.record === 'entity');
        const names = entities.map((r) => r.detail?.name).filter((n): n is string => typeof n === 'string');
        return fauxAssistantMessage(fauxText(tr("Local rxd completed a real JavaScript structure query and returned {count} entities.{names}\n\nInspect the evidence below or export the result. This uses a deterministic test model; the explanation is based only on the tool’s returned structure.", { count: entities.length, names: names.length ? tr("\n\nNavigable names: {list}.", { list: names.slice(0, 12).join(tr(", ")) }) : '' })));
      }
      return fauxAssistantMessage(fauxText(last.isError
        ? tr("The local tool failed or was interrupted; the error is saved.")
        : last.toolName === 'shell' ? tr("The local script ran; its real output and exit status are saved.")
        : tr("Local rxd finished the real JavaScript structure analysis; the result is saved.")));
    }
    const userText = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')) : '';
    const selectedSkill = /<arxd-skill id="([a-f0-9-]{36})" version="([a-f0-9]{64})"\/>/.exec(userText);
    if (selectedSkill && host.skills) return fauxAssistantMessage(fauxToolCall('skill_load', { id: selectedSkill[1], version: selectedSkill[2] }, { id: `skill-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
    if (userText.includes('<arxd-workspace>')) {
      const capture = /<arxd-file id="([a-f0-9-]+)" sha256="([a-f0-9]{64})" engine="([a-f0-9]{64})"[^>]*supported="([01])"\/>/.exec(userText);
      if (capture) {
        if (capture[4] === '0') return fauxAssistantMessage(fauxText(tr("The file is saved in this conversation. Use rxd_file_outline for UTF-8 JavaScript up to 4 KiB; analyze other formats through the shell with $ARXD_RXD.")));
        return fauxAssistantMessage(fauxToolCall('rxd_file_outline', { fileId: capture[1], inputSha256: capture[2], engineSha256: capture[3] }, { id: `file-${context.messages.filter((m) => m.role === 'user').length}` }), { stopReason: 'toolUse' });
      }
      if (!/脚本环境|shell|python|node/i.test(userText.split('\n\n<arxd-workspace>')[0])) {
        return fauxAssistantMessage(fauxText(tr("The question is saved in the conversation. The fixed test model is active: add a file or use the built-in sample to see real structure results through local rxd; you can also run the script environment check.")));
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
