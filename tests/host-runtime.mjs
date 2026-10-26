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
  // Every analysis goes through the managed shell, so tests always provide one.
  // An explicit `false` keeps a host without shell for the few tests that need it.
  if (shellOptions === undefined) {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'arxd-host-shell-'));
    await mkdir(join(root, 'home'), { recursive: true });
    shellOptions = { root, jobs: new Map(), previews: new Map() };
  } else if (shellOptions === false) shellOptions = undefined;
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
    probe: async (script, timeoutMs) => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const home = await mkdtemp(join(tmpdir(), 'arxd-probe-home-'));
      const started = performance.now();
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', script], {
            env: { ...process.env, HOME: home, TMPDIR: home, ARXD_RXD: binary },
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', (bytes) => { stdout += bytes; });
          child.stderr.on('data', (bytes) => { stderr += bytes; });
          child.on('error', reject);
          child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        });
        return { ...result, durationMs: performance.now() - started };
      } finally { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); }
    },
  };
}

export async function openHostPoc(path, binary, checkpoint, shellOptions) {
  return openVerificationHarness(openDatabase(path), await createHost(binary, checkpoint, shellOptions));
}
