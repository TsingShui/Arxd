import { requireVerification } from './access';
import Rxd, { type ImportedApp } from '../../modules/rxd';
import { attachmentFiles } from '../workspace/apk-set.ts';
import type { Workspace } from '../workspace/core';

/** Real PackageManager import plus real rxd analysis of the captured bytes. */
export async function verifyInstalledApps(core: Workspace) {
  requireVerification();
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  async function rejected(action: () => Promise<unknown>, label: string) {
    let failed = false; try { await action(); } catch { failed = true; }
    assert(failed, label);
  }
  // Splits prove the set path; fall back to the smallest app when none has splits.
  const page = await Rxd.listInstalledApps('', 0, false);
  assert(page.apps.length > 0, 'PackageManager lists user applications');
  const candidates = [...page.apps].sort((left, right) => left.bytes - right.bytes);
  const target = candidates.find((app) => app.apkCount > 1) ?? candidates[0];
  assert(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(target.packageName) && /^[a-f0-9]{64}$/.test(target.revision),
    'Listed application carries a package identity and revision');

  await rejected(() => Rxd.importInstalledApp(target.packageName, 'f'.repeat(64), 8 * 1073741824), 'Stale revision refused');
  await rejected(() => Rxd.importInstalledApp('../escape', target.revision, 8 * 1073741824), 'Invalid package name refused');

  const imported: ImportedApp = await Rxd.importInstalledApp(target.packageName, target.revision, 8 * 1073741824);
  assert(imported.packageName === target.packageName && imported.files.length === target.apkCount, 'Base and split APKs captured');
  assert(imported.files.every((file) => file.format === 'APK' && file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256) && file.source === null),
    'Every APK capture is an immutable, digest-bound file');

  // Import identity is proven here; analysis of these captures is the Agent's
  // job through the same immutable paths and is verified separately.
  const base = imported.files[0];
  assert(new Set(imported.files.map((file) => file.sha256)).size === imported.files.length, 'Every APK of the set has a distinct digest');

  await core.select(null); await core.model('test');
  const attached = await core.attachInstalledApp(imported);
  const snapshot = core.getSnapshot();
  const ids = imported.files.map((file) => file.id);
  assert(attached.apkSet?.packageName === target.packageName && attached.apkSet?.fileIds.join() === ids.join(),
    'Attachment owns the ordered base-plus-split set');
  assert(ids.every((id) => snapshot.files.some((file) => file.id === id)), 'Every APK of the set is in the conversation');
  const resolved = await attachmentFiles(attached, async (id) => imported.files.find((file) => file.id === id) ?? (await core.fileLibrary.get(id))?.file);

  const report = { event: 'arxd-installed-apps', verified: true, checks,
    target: { packageName: target.packageName, label: target.label, versionName: target.versionName,
      versionCode: target.versionCode, apkCount: target.apkCount, bytes: target.bytes },
    baseSha256: base.sha256, apkSha256: imported.files.map((file) => file.sha256), splitNames: imported.files.slice(1).map((file) => file.name),
    resolvedCount: resolved.length };
  Rxd.report(JSON.stringify(report));

  // Evidence keeps digests, not hundreds of megabytes of another app's APKs.
  for (const file of imported.files) await core.fileLibrary.remove(file.id);
  return report;
}
