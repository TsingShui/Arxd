import type { ImportedApp, WorkspaceFile } from '../../modules/rxd/index.ts';
import { tr } from '../i18n/base.ts';
import { MAX_IMPORT_BYTES } from './limits.ts';

/** One primary attachment owns a bounded, ordered base + split capture set. */
export function validateApkSet(file: WorkspaceFile) {
  const set = file.apkSet;
  if (!set) return;
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(set.packageName) || set.packageName.length > 240 ||
      typeof set.label !== 'string' || set.label.length > 240 ||
      (set.versionName !== null && (typeof set.versionName !== 'string' || set.versionName.length > 240)) ||
      !/^\d{1,20}$/.test(set.versionCode) || !Array.isArray(set.fileIds) ||
      set.fileIds.length < 1 || set.fileIds.length > 128 || set.fileIds[0] !== file.id ||
      new Set(set.fileIds).size !== set.fileIds.length || set.fileIds.some((id) => !/^[a-f0-9-]{1,128}$/.test(id)) ||
      file.format !== 'APK' || file.source !== null) throw new Error('Invalid APK set identity');
}

export function importedAppFiles(app: ImportedApp): WorkspaceFile[] {
  if (!app.files.length || app.files.length > 128 || app.files.some((file) => file.format !== 'APK' || file.source !== null || file.apkSet) ||
      app.files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) throw new Error('Invalid imported APK set');
  const [base, ...splits] = app.files;
  const primary: WorkspaceFile = { ...base, apkSet: { packageName: app.packageName, label: app.label,
    versionName: app.versionName, versionCode: app.versionCode, fileIds: app.files.map((file) => file.id) } };
  validateApkSet(primary);
  return [primary, ...splits];
}

export async function attachmentFiles(primary: WorkspaceFile, resolve: (id: string) => Promise<WorkspaceFile | undefined>) {
  validateApkSet(primary);
  if (!primary.apkSet) return [primary];
  const files: WorkspaceFile[] = [primary];
  for (const id of primary.apkSet.fileIds.slice(1)) {
    const file = await resolve(id);
    if (!file || file.format !== 'APK' || file.source !== null || file.apkSet) throw new Error(tr('An APK in this application snapshot is unavailable. Import the application again.'));
    files.push(file);
  }
  return files;
}
