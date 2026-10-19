import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Real temporary files behind the host interface; Android boundaries have their own device verifier. */
export function createSkillHost(root) {
  const work = join(root, 'workspace/skills');
  const versions = join(root, 'versions');
  async function current(id) {
    const children = await readdir(join(work, id));
    if (children.length !== 1) throw new Error('Expected one managed directory');
    return join(work, id, children[0]);
  }
  async function working(id) {
    const path = await current(id), data = await readFile(join(path, 'SKILL.md'));
    return { id, folder: path.split('/').at(-1), path: path.slice(join(root, 'workspace').length + 1), definition: data.toString('utf8'), sha256: hash(data) };
  }
  async function install(id, source, single) {
    const target = join(work, id, 'incoming');
    await mkdir(target, { recursive: true });
    if (single) await cp(source, join(target, 'SKILL.md')); else await cp(source, target, { recursive: true });
    return working(id);
  }
  return {
    importFile: (id, uri) => install(id, fileURLToPath(uri), true),
    importWorkspace: (id, path) => install(id, join(root, 'workspace', path), false),
    working,
    write: async (id, text, expected) => {
      const path = join(await current(id), 'SKILL.md');
      if (hash(await readFile(path)) !== expected) throw new Error('Skill file changed');
      await writeFile(path, text);
    },
    snapshot: async (id, name, prune) => {
      let path = await current(id);
      const destination = join(work, id, name);
      if (path !== destination) { await rename(path, destination); path = destination; }
      const files = [];
      const directories = [];
      async function walk(directory, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('Symbolic skill resource');
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { directories.push(relative); await walk(join(directory, entry.name), relative); }
          else { const data = await readFile(join(directory, entry.name)); files.push({ path: relative, size: data.length, sha256: hash(data) }); }
        }
      }
      await walk(path); files.sort((a, b) => a.path.localeCompare(b.path));
      const version = hash([...directories.map((path) => `d\0${path}`), ...files.map((file) => `f\0${file.path}\0${file.sha256}\0${file.size}`)].sort().join('\n'));
      const baseDirectory = join(versions, id, version, name);
      await mkdir(join(versions, id, version), { recursive: true });
      try { await stat(baseDirectory); } catch { await cp(path, baseDirectory, { recursive: true }); }
      if (prune) for (const old of await readdir(join(versions, id))) if (old !== version) await rm(join(versions, id, old), { recursive: true, force: true });
      const definition = await readFile(join(baseDirectory, 'SKILL.md'), 'utf8');
      return { id, name, version, workingPath: `skills/${id}/${name}`, baseDirectory, definition, definitionSha256: hash(Buffer.from(definition)), files, totalBytes: files.reduce((n, file) => n + file.size, 0) };
    },
    read: async (id, name, version, path, expected, offset, limit) => {
      const data = await readFile(join(versions, id, version, name, path));
      if (hash(data) !== expected) throw new Error('Pinned resource identity changed');
      let end = Math.min(data.length, offset + limit);
      while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
      return { path, sha256: expected, size: data.length, text: data.includes(0) ? null : data.subarray(offset, end).toString('utf8'), offset, nextOffset: end, complete: end === data.length };
    },
    remove: async (id) => { await rm(join(work, id), { recursive: true, force: true }); await rm(join(versions, id), { recursive: true, force: true }); },
  };
}
