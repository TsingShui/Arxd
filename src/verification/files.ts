import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import { MAX_IMPORT_BYTES } from '../workspace/limits.ts';
import type { FileRoot } from '../../modules/rxd';
import type { Workspace } from '../workspace/core';

/** Own isolated directories only; no model request or imported code execution. */
export async function verifyFiles(core: Workspace) {
  requireVerification();
  const token = globalThis.crypto.randomUUID();
  const directory = `arxd-files-${token}`;
  const source = 'export function fileManagerProbe(value) { return value + 42; }\n// 文件证据 ✓\n';
  const before = core.getSnapshot();
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  async function rejected(action: () => Promise<unknown>, label: string) {
    let failed = false; try { await action(); } catch { failed = true; }
    assert(failed, label);
  }
  let capture: Awaited<ReturnType<Workspace['captureFile']>> | undefined;
  let saved: Awaited<ReturnType<Workspace['saveArtifact']>> | undefined;
  let proof: { event: string; verified: boolean; checks: string[]; savedFile: { id: string; name: string; sha256: string }; directory: string } | undefined;
  try {
    await Rxd.createDirectory('workspace', directory);
    await Rxd.createDirectory('home', directory);
    const path = `${directory}/证据-✓.js`;
    await Rxd.writeFile('workspace', path, source, '');
    const first = await Rxd.readFile('workspace', path);
    assert(first.text === source && !!first.sha256, 'UTF-8 source and read identity');
    await Rxd.writeFile('workspace', path, source + '// edited\n', first.sha256!);
    await rejected(() => Rxd.writeFile('workspace', path, 'wrong', first.sha256!), 'Stale edit rejected');
    assert((await Rxd.readFile('workspace', path)).text === source + '// edited\n', 'Rejected edit preserved bytes');
    await Rxd.copyFile('workspace', path, 'home', `${directory}/copy.js`);
    assert((await Rxd.readFile('home', `${directory}/copy.js`)).text === source + '// edited\n', 'Copy across workspace and Home');
    await Rxd.moveFile('home', `${directory}/copy.js`, 'home', `${directory}/moved.js`);
    assert((await Rxd.listFiles('home', directory, 0, 'moved')).entries.length === 1, 'Move and name search');
    await Rxd.writeFile('workspace', `${directory}/binary.bin`, '\u0000\u0001data', '');
    assert((await Rxd.readFile('workspace', `${directory}/binary.bin`)).text === null, 'Binary preview is explicit');
    await rejected(() => Rxd.writeFile('workspace', `${directory}/oversize.txt`, 'x'.repeat(262145), ''), 'Text size budget rejected');
    await rejected(() => Rxd.listFiles('workspace', '../', 0, ''), 'Parent traversal rejected');
    await rejected(() => Rxd.listFiles('workspace', '/data', 0, ''), 'Absolute path rejected');
    await rejected(() => Rxd.listFiles('invalid' as FileRoot, '', 0, ''), 'Unknown root rejected');
    await rejected(() => Rxd.writeFile('runtime', 'arxd-must-not-exist', 'bad', ''), 'Runtime root is read-only');
    const shell = await Rxd.runTermux(`set -eu\nln -s "$ARXD_WORKSPACE/${path}" "$ARXD_TERMUX_ROOT/home/${directory}/link.js"\nfor n in {1..205}; do printf x > "$ARXD_WORKSPACE/${directory}/page-$n"; done\n`, 10000);
    assert(shell.exitCode === 0, 'Agent runtime shares actual file roots');
    await rejected(() => Rxd.readFile('home', `${directory}/link.js`), 'Symbolic link read rejected');
    await Rxd.deleteFile('home', `${directory}/link.js`);
    assert((await Rxd.readFile('workspace', path)).text === source + '// edited\n', 'Deleting link preserved target');
    const page1 = await Rxd.listFiles('workspace', directory, 0, 'page-');
    const page2 = await Rxd.listFiles('workspace', directory, page1.nextOffset!, 'page-');
    assert(page1.entries.length === 200 && page2.entries.length === 5 && page2.nextOffset === null, 'Directory pagination is complete');
    capture = await core.captureFile('workspace', path);
    assert(capture.source === source + '// edited\n', 'Immutable capture uses current bytes');
    const shared = await Rxd.shareCapture(capture.uri, capture.sha256, capture.name);
    const roundtrip = await Rxd.importFile(shared, capture.name, MAX_IMPORT_BYTES);
    assert(roundtrip.sha256 === capture.sha256 && roundtrip.size === capture.size, 'Shared export preserves captured bytes');
    await Rxd.deleteCapture(roundtrip.uri, roundtrip.sha256);
    await core.select(null); await core.model('test');
    await core.attachExisting(capture.id);
    await core.send('查询文件管理器验证样本的结构。', capture.id);
    const firstConversation = core.getSnapshot().active!;
    assert(core.getSnapshot().turns.at(-1)?.tools[0]?.text.includes('fileManagerProbe'), 'Real Android rxd analyzed the capture');
    const report = core.getSnapshot().artifacts.find((item) => item.kind === 'report')!;
    saved = await core.saveArtifact(report.id);
    assert((await core.saveArtifact(report.id)).id === saved.id, 'Saved artifact is idempotent');
    await core.select(null); await core.attachExisting(capture.id);
    const second = core.getSnapshot().active!;
    await core.fileLibrary.rename(capture.id, '文件库验证-✓.js');
    assert(core.getSnapshot().files[0].name === '文件库验证-✓.js' && (await core.fileLibrary.usage(capture.id)).length === 2, 'Shared capture metadata and references');
    await core.forget(firstConversation);
    assert((await core.fileLibrary.get(capture.id))?.status === 'active', 'Conversation removal retained capture');
    await core.fileLibrary.remove(capture.id);
    assert(core.getSnapshot().files[0].available === false && (await core.fileLibrary.get(saved.id))?.status === 'active', 'File deletion retained messages and saved report');
    await rejected(() => core.attachExisting(capture!.id), 'Deleted capture cannot be attached');
    await core.forget(second);
    proof = { event: 'arxd-files', verified: true, checks, savedFile: { id: saved.id, name: saved.name, sha256: saved.sha256 }, directory };
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const root of ['workspace', 'home'] as FileRoot[]) { try { await Rxd.deleteFile(root, directory); } catch (error) { cleanupErrors.push(error); } }
    await core.select(null); await core.model(before.model); await core.thinking(before.thinking); await core.select(before.active);
    if (proof && cleanupErrors.length) throw new Error('File probe cleanup failed');
  }
  Rxd.report(JSON.stringify(proof));
}
