import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { ArxdSqlite } from '../src/agent/sqlite.ts';
import { openVerificationHarness } from '../src/verification/harness.ts';

export function openDatabase(path) {
  const native = new DatabaseSync(path);
  native.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return new ArxdSqlite({
    execAsync: async (sql) => { native.exec(sql); },
    runAsync: async (sql, ...args) => native.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => native.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => native.prepare(sql).all(...args).map((row) => ({ ...row })),
    closeAsync: async () => { native.close(); },
  });
}

export async function createHost(binary, checkpoint, shellOptions) {
  const engineSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  return {
    info: { engineSha256, sourceRevision: 'host-test', abi: process.arch, sdk: 0, pageSize: 0 },
    checkpoint,
    shell: shellOptions ? {
      afterRun: shellOptions.afterRun,
      progress: (id) => shellOptions.previews?.get(id) ?? null,
      cancel: (id) => {
        const child = shellOptions.jobs.get(id);
        if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      },
      run: (id, script, timeoutMs) => new Promise((resolve, reject) => {
        const started = performance.now();
        const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', script], {
          cwd: `${shellOptions.root}/home`, detached: true,
          env: { ...process.env, PATH: `${shellOptions.root}/usr/bin:${process.env.PATH}`,
            ARXD_TERMUX_ROOT: shellOptions.root, ARXD_RXD: binary },
        });
        shellOptions.jobs.set(id, child);
        let stdout = '', stderr = '';
        const preview = () => shellOptions.previews?.set(id, { stdoutTail: stdout.slice(-8192), stderrTail: stderr.slice(-8192) });
        child.stdout.on('data', (bytes) => { stdout += bytes; preview(); });
        child.stderr.on('data', (bytes) => { stderr += bytes; preview(); });
        const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, timeoutMs);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer); shellOptions.jobs.delete(id);
          shellOptions.previews?.delete(id);
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
          resolve({ stdout, stderr, exitCode: code ?? 137,
            stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
            stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
            stderrSha256: createHash('sha256').update(stderr).digest('hex'),
            durationMs: performance.now() - started, job: id, identity: { platform: 'host' } });
        });
      }),
    } : undefined,
    run: async (input) => {
      const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const directory = await mkdtemp(join(tmpdir(), 'arxd-query-'));
      const started = performance.now();
      try {
        const source = join(directory, 'sample.js');
        const bytes = Buffer.from(input.source);
        if (createHash('sha256').update(bytes).digest('hex') !== input.inputSha256) throw new Error('Input identity mismatch');
        if (engineSha256 !== input.engineSha256) throw new Error('Engine identity mismatch');
        await writeFile(source, bytes);
        const { stdout, stderr } = await promisify(execFile)(binary, ['js', 'outline', source, '--jsonl', '--max-output-bytes', '32768'], { timeout: 10_000, maxBuffer: 65536 });
        return { stdout, stderr, exitCode: 0, inputSha256: input.inputSha256, engineSha256, durationMs: performance.now() - started };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

export async function openHostPoc(path, binary, checkpoint, shellOptions) {
  return openVerificationHarness(openDatabase(path), await createHost(binary, checkpoint, shellOptions));
}
