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
import type { EngineInfo } from '../../modules/rxd/index.ts';
import { SHELL_PROBE } from './shell.ts';
import { skillVerificationResponse } from '../verification/skill-provider.ts';
import { capacityVerificationResponse } from '../verification/capacity-provider.ts';
import type { SkillHost } from '../workspace/skills.ts';

export const SAMPLE_SOURCE = 'export function arxdProbe(value) { return value + 1; }\n';
export const SAMPLE_SHA256 = 'd0e6da49d8dbff1ccfd185d4536cc6e3437eb83270570d6ca0b45699001d9c21';
export const SAMPLE_TOOL = 'verification_rxd_sample';

export type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/** The trusted, deterministic part of the verification runtime. */
export type OfflineHost = {
  /** Trusted deterministic provider boundary for native verification; never applied to live models. */
  offlineResponse?: (...args: Parameters<FauxResponseFactory>) => ReturnType<FauxResponseFactory> | undefined | Promise<Awaited<ReturnType<FauxResponseFactory>> | undefined>;
  info: EngineInfo;
  /** Trusted verification runner for a fixed script in the managed environment. */
  probe?(script: string, timeoutMs: number): Promise<ProbeResult>;
  checkpoint?(context: { abortSignal?: AbortSignal }): Promise<void>;
  skills?: SkillHost;
};

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const xmlText = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** What the deterministic test Agent runs for one attachment: verify identity, then ask the bundled rxd CLI. */
export function attachmentScript(path: string, sha256: string, format: string) {
  const analyze = ['JS', 'MJS', 'CJS'].includes(format) ? `"$ARXD_RXD" js entities "$f"`
    : ['APK', 'DEX'].includes(format) ? `"$ARXD_RXD" dex classes "$f"`
      : '"$ARXD_RXD" --help';
  return `set -eu\nf=${quote(path)}\nactual=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1)\n` +
    `test "$actual" = ${quote(sha256)} || { echo 'Input identity mismatch' >&2; exit 3; }\n${analyze}\n`;
}

const SAMPLE_SCRIPT = `set -eu\nf="\${TMPDIR:-$HOME}/arxd-verification-sample-$$.js"\ntrap 'rm -f "$f"' EXIT\nprintf '%s' ${quote(SAMPLE_SOURCE)} > "$f"\n"$ARXD_RXD" js entities "$f"\n`;

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
      return fauxAssistantMessage(fauxText(last.isError
        ? tr("The local tool failed or was interrupted; the error is saved.")
        : tr("The local script ran; its real output and exit status are saved.")));
    }
    const userText = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')) : '';
    const selectedSkill = /<arxd-skill id="([a-f0-9-]{36})" version="([a-f0-9]{64})"\/>/.exec(userText);
    if (selectedSkill && host.skills) return fauxAssistantMessage(fauxToolCall('skill_load', { id: selectedSkill[1], version: selectedSkill[2] }, { id: `skill-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
    if (userText.includes('<arxd-workspace>')) {
      const capture = /<arxd-file id="[a-f0-9-]+" sha256="([a-f0-9]{64})" path="([^"]*)" format="([^"]*)"\/>/.exec(userText);
      if (capture) return fauxAssistantMessage(fauxToolCall('shell', { script: attachmentScript(xmlText(capture[2]), capture[1], xmlText(capture[3])), timeoutMs: 60000 }, { id: `file-${context.messages.filter((m) => m.role === 'user').length}` }), { stopReason: 'toolUse' });
      if (!/脚本环境|shell|python|node/i.test(userText.split('\n\n<arxd-workspace>')[0])) {
        return fauxAssistantMessage(fauxText(tr("The question is saved in the conversation. The fixed test model is active: add a file and analyze it through the shell with $ARXD_RXD; you can also run the script environment check.")));
      }
      const script = userText.startsWith('运行 Shell 停止验证') ? 'printf "Arxd cancellation probe started\\n"; sleep 30; printf "probe completed\\n"' : SHELL_PROBE;
      return fauxAssistantMessage(fauxToolCall('shell', { script, timeoutMs: 60000 }, { id: `shell-${context.messages.filter((m) => m.role === 'user').length}` }), { stopReason: 'toolUse' });
    }
    if (last?.role === 'user' && JSON.stringify(last.content).includes('脚本环境')) {
      return fauxAssistantMessage(fauxToolCall('shell', { script: SHELL_PROBE, timeoutMs: 60000 },
        { id: `shell-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall(SAMPLE_TOOL, {}, { id: `rxd-${context.messages.filter((message) => message.role === 'user').length}` }), { stopReason: 'toolUse' });
  };
  provider.setResponses([respond]);
  return provider;
}

/** Register fixtures that are only meaningful with the deterministic provider. */
export function offlineExtension(host: OfflineHost) {
  const probe = host.probe;
  return defineExtension({
    name: 'arxd-offline',
    tools: probe ? [defineTool({
      name: SAMPLE_TOOL,
      description: 'Verification fixture: analyze the fixed built-in sample with the installed rxd. Not offered to Agents.',
      parameters: Type.Object({}),
      replay: 'safe',
      outputLimits: { maxBytes: 32768, maxLines: 128, retain: 'head' },
      execute: async (_input, _api, context) => {
        // This deliberate test gate is reached after Pi commits tool intent.
        // It lets a device/process kill test interrupt a real pending task.
        await host.checkpoint?.(context);
        if (context.abortSignal?.aborted) throw new Error('rxd task cancelled before execution');
        const started = Date.now();
        const result = await probe(SAMPLE_SCRIPT, 30000);
        if (result.exitCode !== 0) throw new Error(`rxd exit ${result.exitCode}: ${result.stderr}`);
        if (!result.stdout.includes('arxdProbe')) throw new Error('rxd did not return the expected sample function');
        return {
          output: [{ type: 'text', text: result.stdout }],
          details: { stderr: result.stderr, exitCode: result.exitCode, inputSha256: SAMPLE_SHA256, engineSha256: host.info.engineSha256, durationMs: Date.now() - started },
        };
      },
    })] : [],
  });
}
