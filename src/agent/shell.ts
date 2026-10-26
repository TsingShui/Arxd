import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import type { TermuxResult } from '../../modules/rxd/index.ts';

export type ShellHost = {
  run(requestId: string, script: string, timeoutMs: number): Promise<TermuxResult>;
  cancel(requestId: string): void;
  progress?(requestId: string): { stdoutTail: string; stderrTail: string } | null;
  afterRun?(result: TermuxResult, context: { abortSignal?: AbortSignal }): Promise<void>;
};

export function shellTool(host: ShellHost) {
  return defineTool({
    name: 'shell',
    description: 'Run a script in Arxd’s managed Bash/Python/Node environment. Files persist; each call starts a fresh shell. Real Termux android-tools provides unrestricted adb shell/exec-out after user setup; ordinary scripts remain App UID, while an authorized adb shell is UID 2000. Use scripts for trusted analysis algorithms; never execute analyzed samples. Interrupted calls are not automatically retried.',
    parameters: Type.Object({
      script: Type.String({ minLength: 1, maxLength: 16384 }),
      timeoutMs: Type.Integer({ minimum: 1, maximum: 600000 }),
    }),
    replay: 'unsafe',
    executionMode: 'sequential',
    outputLimits: { maxBytes: 49152, maxLines: 512, retain: 'tail' },
    execute: async ({ script, timeoutMs }, api, context) => {
      if (context.abortSignal?.aborted) throw new Error('Shell task cancelled before execution');
      const requestId = String(api.taskId);
      const cancel = () => host.cancel(requestId);
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
      let last = '';
      let inFlight: Promise<void> | undefined;
      let progressError = false;
      const timer = host.progress ? setInterval(() => {
        if (inFlight || progressError || context.abortSignal?.aborted) return;
        try {
          const progress = host.progress!(requestId);
          if (!progress) return;
          const next = JSON.stringify(progress);
          if (next === last) return;
          last = next;
          inFlight = api.details({ ...progress, preview: true }, context).catch(() => { progressError = true; }).finally(() => { inFlight = undefined; });
        } catch { progressError = true; }
      }, 500) : undefined;
      try {
        const result = await host.run(requestId, script, timeoutMs);
        await host.afterRun?.(result, context);
        if (context.abortSignal?.aborted) throw new Error('Shell task cancelled');
        return {
          isError: result.exitCode !== 0,
          output: [{ type: 'text' as const, text: JSON.stringify({
            exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          }) }],
          details: { ...result, replay: 'unsafe' },
        };
      } finally {
        clearInterval(timer);
        await inFlight;
        context.abortSignal?.removeEventListener('abort', cancel);
      }
    },
  });
}

// Trusted verification program, independent of analyzed sample execution.
export const SHELL_PROBE = `set -eu
python -c 'import json, os; print(json.dumps({"python": 6 * 7, "uid": os.getuid()}))'
node -e 'console.log(JSON.stringify({node: 7 * 8, uid: process.getuid()}))'
capture="$ARXD_TERMUX_ROOT/home/pi-shell-sample.js"
trap 'rm -f "$capture"' EXIT
printf '%s\\n' 'export function arxdProbe(value) { return value + 1; }' > "$capture"
"$ARXD_RXD" js outline "$capture" --jsonl --max-output-bytes 32768
python - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ['ARXD_TERMUX_ROOT']) / 'home/pi-shell-count'
with p.open('ab') as f:
    f.write(b'run\\n'); f.flush(); os.fsync(f.fileno())
print(json.dumps({'shellCount': len(p.read_bytes().splitlines())}))
PY
`;
