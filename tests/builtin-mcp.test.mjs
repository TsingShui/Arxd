import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistry } from '@earendil-works/pi-durable';
import { McpLibrary, RXD_BUILTIN_NAME, rxdBuiltinDefinition } from '../src/workspace/services-library.ts';
import { openDatabase } from './host-runtime.mjs';

const host = {
  mcpStates: async () => [],
  mcpHttpPolicy: () => ({ version: 1, allowPlaintextHttp: false, source: 'default', error: null }),
  mcpEnabled: async () => { throw new Error('built-in must not toggle native state'); },
  credentials: { get: async () => undefined, set: async () => {}, remove: async () => {} },
};
const store = (text = '') => {
  let saved = text ? { text, sha256: 'a'.repeat(64) } : null;
  return { read: async () => saved, write: async (value) => { saved = { text: value, sha256: 'b'.repeat(64) }; return { sha256: saved.sha256 }; }, get text() { return saved?.text ?? ''; } };
};

test('built-in rxd MCP server launches the bundled engine with explicit roots', () => {
  const definition = rxdBuiltinDefinition('/app/lib/librxd.so', ['/data/workspace', '/data/workspace-inputs']);
  assert.equal(definition.name, RXD_BUILTIN_NAME);
  assert.equal(definition.transport, 'stdio');
  assert.equal(definition.exposure, 'codemode', 'analysis tools stay out of the prompt and are called through codemode');
  assert.deepEqual(definition.launch.argv, ['/app/lib/librxd.so', 'mcp', 'serve', '--root', '/data/workspace', '--root', '/data/workspace-inputs']);
  assert.equal(definition.launch.identity, 'app');
  assert.equal(rxdBuiltinDefinition('/x', ['/y']).id, definition.id, 'identity is stable across processes');
});

test('built-in server is listed but never persisted, edited, removed or shadowed by user configuration', async () => {
  const builtin = rxdBuiltinDefinition('/app/lib/librxd.so', ['/data/workspace']);
  const config = store(JSON.stringify({ mcpServers: { user: { command: 'python', args: ['server.py'] } } }));
  const library = new McpLibrary(openDatabase(':memory:'), host, createRegistry(), config, builtin);
  await library.open();
  const listed = await library.list();
  assert.deepEqual(listed.map((item) => item.name).sort(), [RXD_BUILTIN_NAME, 'user']);
  assert.ok(!config.text.includes(RXD_BUILTIN_NAME), 'user mcp.json never receives the bundled server');
  await assert.rejects(library.remove(builtin.id), /cannot be removed/);
  await assert.rejects(library.credentials(builtin.id, { Authorization: 'x' }), /needs no credentials/);
  await assert.rejects(library.configure({ ...builtin, id: builtin.id }), /cannot be edited/);
  assert.equal((await library.enabled(builtin.id, false)).enabled, true, 'disabling is a no-op for the bundled server');
  await assert.rejects(library.configure({ name: RXD_BUILTIN_NAME, transport: 'http', enabled: true, url: 'https://example.invalid/mcp' }), /reserved/);
});

test('builds without rxd register no built-in server', async () => {
  const library = new McpLibrary(openDatabase(':memory:'), host, createRegistry(), store());
  await library.open();
  assert.deepEqual(await library.list(), []);
});
