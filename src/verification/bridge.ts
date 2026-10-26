import { requireVerification } from './access';
import '../runtime';
import { openDatabaseAsync } from 'expo-sqlite';
import Rxd from '../../modules/rxd';
import { openVerificationHarness, waitForProcessKill, type VerificationSnapshot } from './harness.ts';
import { ArxdSqlite } from '../agent/sqlite.ts';

let opening: Promise<Awaited<ReturnType<typeof openVerificationHarness>>> | undefined;
let checkpointEnabled = false;
let checkpointListener: (() => void) | undefined;
let shellCheckpointEnabled = false;

export function enableShellCheckpoint() { shellCheckpointEnabled = true; }

export function enableCheckpoint(listener: () => void) {
  checkpointEnabled = true;
  checkpointListener = listener;
}

export function openVerificationBridge() {
  requireVerification();
  opening ??= (async () => {
    const database = await openDatabaseAsync('arxd-verification.sqlite');
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    const info = await Rxd.getInfo();
    return openVerificationHarness(new ArxdSqlite(database), {
      info,
probe: async (script: string, timeoutMs: number) => {
        const result = await Rxd.runTermux(script, timeoutMs);
        if (result.exitCode !== 0) throw new Error(result.stderr || `rxd probe exit ${result.exitCode}`);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
      shell: {
        run: (id, script, timeoutMs) => {
          Rxd.registerShell(id);
          return Rxd.runShell(id, script, timeoutMs);
        },
        cancel: (id) => Rxd.cancelShell(id),
        afterRun: async (result, context) => {
          if (!shellCheckpointEnabled) return;
          await Rxd.report(JSON.stringify({ event: 'arxd-verification', stage: 'shell-checkpoint', job: result.job, exitCode: result.exitCode }));
          await waitForProcessKill(context);
        },
      },
      checkpoint: async (context) => {
        if (!checkpointEnabled) return;
        await Rxd.report(JSON.stringify({ event: 'arxd-verification', stage: 'checkpoint', engineSha256: info.engineSha256 }));
        checkpointListener?.();
        await waitForProcessKill(context);
      },
    });
  })();
  return opening;
}

export async function publishSnapshot(stage: string, snapshot: VerificationSnapshot) {
  requireVerification();
  const { tools, ...summary } = snapshot;
  await Rxd.report(JSON.stringify({
    event: 'arxd-verification', stage, ...summary,
    toolIdentities: tools.map((tool) => {
      if (tool.name !== 'shell') return tool.details;
      const details = tool.details as { exitCode?: number; job?: string; identity?: unknown } | undefined;
      let records: Record<string, unknown>[] = [];
      try {
        const output = JSON.parse(tool.text);
        records = output.stdout.split('\n').flatMap((line: string) => {
          try {
            const value = JSON.parse(line);
            return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
          } catch { return []; }
        });
      } catch { /* interrupted calls have Pi's error text rather than shell JSON */ }
      return { tool: 'shell', exitCode: details?.exitCode, job: details?.job, identity: details?.identity,
        interrupted: /interrupt/i.test(tool.text),
        python: records.find((r) => 'python' in r)?.python,
        node: records.find((r) => 'node' in r)?.node,
        shellCount: records.find((r) => 'shellCount' in r)?.shellCount,
        rxdFunction: records.some((r) => r.record === 'entity' && (r.detail as { name?: string })?.name === 'arxdProbe'),
      };
    }),
  }));
}

export async function publishShellCount() {
  requireVerification();
  const result = await Rxd.runTermux(`python -c 'import os,pathlib; p=pathlib.Path(os.environ["ARXD_TERMUX_ROOT"])/"home/pi-shell-count"; print(len(p.read_bytes().splitlines()) if p.exists() else 0)'`, 10000);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  const count = Number(result.stdout.trim());
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid shell counter');
  await Rxd.report(JSON.stringify({ event: 'arxd-verification', stage: 'shell-inspect', count }));
}

export async function publishError(error: unknown) {
  requireVerification();
  await Rxd.report(JSON.stringify({ event: 'arxd-verification', stage: 'error', error: String(error) }));
}
