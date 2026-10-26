import { requireNativeModule } from 'expo';

export type EngineInfo = {
  engineSha256: string;
  available?: boolean;
  sourceRevision: string;
  /** Absolute librxd path inside nativeLibraryDir; empty in builds without rxd (Lite). */
  rxdPath?: string;
  /** App-private file-manager workspace; an allowed root of the built-in rxd MCP server. */
  workspacePath?: string;
  /** Immutable attachment captures; also an allowed root of the built-in rxd MCP server. */
  inputsPath?: string;
  abi: string;
  sdk: number;
  pageSize: number;
  processId?: number;
  debuggable?: boolean;
};

export type TermuxResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  durationMs: number;
  job: string;
  identity: Record<string, string | number | boolean>;
};

export type WorkspaceFile = {
  id: string;
  name: string;
  uri: string;
  size: number;
  sha256: string;
  source: string | null;
  format: string;
  available?: boolean;
  apkSet?: ApkSet;
};

export type ApkSet = { packageName: string; label: string; versionName: string | null; versionCode: string; fileIds: string[] };
export type InstalledApp = { packageName: string; label: string; versionName: string | null; versionCode: string; revision: string; apkCount: number; bytes: number; system: boolean };
export type InstalledAppPage = { apps: InstalledApp[]; nextOffset: number | null };
export type ImportedApp = Pick<InstalledApp, 'packageName' | 'label' | 'versionName' | 'versionCode'> & { files: WorkspaceFile[] };

export type CodeModeInfo = { protocol: number; hostSha256: string; wasmSha256: string; hostBytes: number; wasmBytes: number };
export type CodeModeExit = { code: number; stderr: string };
export type FileRoot = 'skills' | 'workspace' | 'home' | 'runtime' | 'models';
export type FileEntry = { root: FileRoot; path: string; name: string; kind: 'file' | 'directory' | 'symlink'; size: number; modifiedAt: number; writable: boolean };
export type FilePage = { entries: FileEntry[]; nextOffset: number | null };
export type FilePreview = { text: string | null; sha256: string | null; size: number; reason?: string | null };
export type SkillDiscovered = { id: string; folder: string; path: string; definition: string; fingerprint: string; origin?: string; error: string | null };
export type SkillDiscovery = { items: SkillDiscovered[]; complete: boolean; alias: string; aliasError: string | null; scannedEntries: number; durationMs: number; revision: string };
export type SkillFile = { path: string; size: number; sha256: string };
export type SkillWorking = { id: string; path: string; folder: string; definition: string; sha256: string };
export type SkillSnapshot = { id: string; name: string; version: string; workingPath: string; baseDirectory: string; definition: string; definitionSha256: string; files: SkillFile[]; totalBytes: number };
export type SkillResource = { path: string; sha256: string; size: number; text: string | null; offset: number; nextOffset: number; complete: boolean };
export type LocalModelRecord = { id: string; name: string; bytes: number; sha256: string; source: 'download' | 'import'; contextWindow: number; maxTokens: number; thinking: boolean; available: boolean };
export type LocalModelOperation = 'idle' | 'downloading' | 'importing' | 'verifying' | 'removing';
export type LocalModelState = { operation: LocalModelOperation; bytes: number; totalBytes: number; models: LocalModelRecord[] };

export default requireNativeModule<{
  localModelStatus(): LocalModelState;
  cancelLocalModelOperation(): void;
  downloadLocalModel(): Promise<void>;
  importLocalModel(uri: string, name: string): Promise<LocalModelRecord & { imported: boolean }>;
  setLocalModelLimits(id: string, contextWindow: number, maxTokens: number, thinking: boolean): Promise<void>;
  stageLocalModelFixture(): Promise<void>;
  localModelFixturePath(): string;
  verifiedLocalModelPath(id: string): Promise<string>;
  removeLocalModel(id: string): Promise<void>;
  verificationEnabled(): boolean;
  getAppIcon(): 'dark' | 'light';
  setAppIcon(style: 'dark' | 'light'): 'dark' | 'light';
  getInfo(): Promise<EngineInfo>;
  report(json: string): void;
  prepareTermux(): Promise<Record<string, string | number | boolean>>;
  startCodeMode(): Promise<CodeModeInfo>;
  writeCodeMode(line: string): void;
  stopCodeMode(): Promise<void>;
  addListener(event: 'onCodeModeMessage', listener: (payload: { line: string }) => void): { remove(): void };
  addListener(event: 'onCodeModeExit', listener: (info: CodeModeExit) => void): { remove(): void };
  runTermux(script: string, timeoutMs: number): Promise<TermuxResult>;
  runShell(requestId: string, script: string, timeoutMs: number): Promise<TermuxResult>;
  registerShell(requestId: string): void;
  cancelShell(requestId: string): void;
  shellProgress(requestId: string): { stdoutTail: string; stderrTail: string } | null;
  keepPreloadAwake(enabled: boolean): Promise<void>;
  listInstalledApps(query: string, offset: number, includeSystem: boolean): Promise<InstalledAppPage>;
  importInstalledApp(packageName: string, revision: string, limitBytes: number): Promise<ImportedApp>;
  importFile(uri: string, name: string, limitBytes: number): Promise<WorkspaceFile>;
  importSource(name: string, source: string): Promise<WorkspaceFile>;
  exportText(name: string, text: string): Promise<string>;
  listFiles(root: FileRoot, path: string, offset: number, query: string): Promise<FilePage>;
  readFile(root: FileRoot, path: string): Promise<FilePreview>;
  writeFile(root: FileRoot, path: string, text: string, expectedSha256: string): Promise<void>;
  createDirectory(root: FileRoot, path: string): Promise<void>;
  moveFile(root: FileRoot, path: string, targetRoot: FileRoot, target: string): Promise<void>;
  copyFile(root: FileRoot, path: string, targetRoot: FileRoot, target: string): Promise<void>;
  deleteFile(root: FileRoot, path: string): Promise<void>;
  captureFile(root: FileRoot, path: string): Promise<WorkspaceFile>;
  saveArtifact(name: string, text: string): Promise<WorkspaceFile>;
  readCapture(uri: string, sha256: string): Promise<FilePreview>;
  copyCapture(uri: string, sha256: string, root: FileRoot, path: string): Promise<void>;
  deleteCapture(uri: string, sha256: string): Promise<void>;
  shareFile(root: FileRoot, path: string): Promise<string>;
  shareCapture(uri: string, sha256: string, name: string): Promise<string>;
  discoverSkills(): Promise<SkillDiscovery>;
  skillsRevision(): Promise<string>;
  renameSkill(id: string, name: string): Promise<void>;
  collectSkillVersions(keep: string[]): Promise<void>;
  importSkillFile(id: string, uri: string): Promise<SkillWorking>;
  importSkillArchive(id: string, uri: string): Promise<SkillWorking>;
  importSkillWorkspace(id: string, path: string): Promise<SkillWorking>;
  importSkillMarket(id: string, files: string, source: string): Promise<SkillWorking>;
  readSkillWorking(id: string): Promise<SkillWorking>;
  writeSkillDefinition(id: string, text: string, expectedSha256: string): Promise<void>;
  snapshotSkill(id: string, name: string, prune: boolean): Promise<SkillSnapshot>;
  readSkillResource(id: string, name: string, version: string, path: string, sha256: string, offset: number, maxBytes: number): Promise<SkillResource>;
  removeSkill(id: string): Promise<void>;
}>('ArxdRxd');
