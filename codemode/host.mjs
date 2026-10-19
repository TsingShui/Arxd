/**
 * Termux Node sidecar for Pi CodeMode.
 *
 * The app keeps the CodeMode host (tools, output, deadline, replay) in Hermes and
 * sends one execution request here. This process owns only the QuickJS VM through
 * Pi's remote sandbox server; tool calls travel back over the JSON-line protocol.
 *
 * Protocol (one JSON object per line):
 *   app -> host  {type:"execute", executionId, request}
 *   app -> host  {type:"reply", requestId, reply}
 *   host -> app  {type:"ready", protocol}
 *   host -> app  {type:"exchange", executionId, requestId, messages}
 *   host -> app  {type:"settled", executionId}
 *   host -> app  {type:"failure", executionId, error}
 *
 * Nothing outside the Pi remote protocol is accepted; the Node process is trusted
 * host code, while the model-written script runs inside QuickJS WASM.
 */
import { createInterface } from 'node:readline';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serveCodemodeRemote } from '@earendil-works/pi-codemode/portable';
import { loadQuickJSWasm } from '@earendil-works/pi-codemode';
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from '../oauth/pi-oauth.mjs';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';

registerBunOAuthFlows();

const PROTOCOL = 1;
const wasmPath = process.argv[2] ?? new URL('../node_modules/quickjs-wasi/quickjs.wasm', import.meta.url).pathname;
const wasm = loadQuickJSWasm(wasmPath);
const pending = new Map();
const executions = new Set();
const oauth = new Map();
const logins = new Map();
const accountProviders = {
  'openai-codex': openaiCodexProvider,
  'kimi-coding': kimiCodingProvider,
  xai: xaiProvider,
};
const authFile = process.env.ARXD_PI_AUTH_FILE || join(process.env.HOME || process.cwd(), '.pi/agent/auth.json');
let nextRequest = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function fail(executionId, error) {
  send({ type: 'failure', executionId, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
}

function oauthSettings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return {
    clientId: typeof raw.clientId === 'string' ? raw.clientId : undefined,
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : undefined,
    callbackPort: Number.isInteger(raw.callbackPort) ? raw.callbackPort : undefined,
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    clientName: typeof raw.clientName === 'string' ? raw.clientName : undefined,
    clientRegistration: raw.clientRegistration === 'cimd' || raw.clientRegistration === 'dcr' ? raw.clientRegistration : undefined,
    authServerMetadataUrl: typeof raw.authServerMetadataUrl === 'string' ? new URL(raw.authServerMetadataUrl) : undefined,
  };
}

async function signIn(requestId, message) {
  const { name, url } = message;
  if (typeof requestId !== 'string' || typeof name !== 'string' || typeof url !== 'string') throw new Error('Invalid OAuth request');
  const store = new McpOAuthCredentialStore().forServer(name, url);
  const signal = new AbortController();
  oauth.set(requestId, signal);
  try {
    await signInMcpServer({ serverUrl: url, store, settings: oauthSettings(message.settings), signal: signal.signal, prompt: {
      showAuthorizationUrl(value) { send({ type: 'oauth-url', requestId, url: value.href }); },
      promptForRedirectUrl(wait) { return new Promise((resolve) => { const stop = () => resolve(undefined); if (wait.aborted) stop(); else wait.addEventListener('abort', stop, { once: true }); }); },
    } });
    send({ type: 'oauth-done', requestId });
  } catch (error) {
    if (!oauth.has(requestId)) send({ type: 'oauth-cancelled', requestId });
    else send({ type: 'oauth-error', requestId, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
  } finally { if (oauth.get(requestId) === signal) oauth.delete(requestId); }
}

async function token(requestId, message) {
  const { name, url } = message;
  if (typeof requestId !== 'string' || typeof name !== 'string' || typeof url !== 'string') throw new Error('Invalid OAuth request');
  const store = new McpOAuthCredentialStore().forServer(name, url);
  const provider = createMcpAuthProvider({ serverUrl: url, store, settings: () => oauthSettings(message.settings), onChallenge: () => {} });
  const value = await provider.token();
  await provider.settled();
  send({ type: 'oauth-token', requestId, token: value ?? null });
}


function accountKey(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(accountProviders, provider)) throw new Error('Unsupported account provider');
  return provider;
}

function accountOAuth(provider) {
  const key = accountKey(provider);
  const oauth = accountProviders[key]().auth?.oauth;
  if (!oauth) throw new Error(`Account login is unavailable for ${key}`);
  return { key, oauth };
}

async function readAccounts() {
  try {
    const value = JSON.parse(await readFile(authFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`Pi auth store is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeAccounts(value) {
  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
  const staging = `${authFile}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(staging, 0o600).catch(() => undefined);
  await rename(staging, authFile);
}

function accountStatus(credential) {
  return {
    signedIn: !!credential,
    ...(credential && typeof credential.expires === 'number' ? { expires: credential.expires } : {}),
    ...(credential && typeof credential.accountId === 'string' ? { accountId: credential.accountId } : {}),
  };
}

function accountEvent(requestId, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'device_code') {
    send({
      type: 'pi-device-code', requestId, userCode: event.userCode, verificationUri: event.verificationUri,
      ...(typeof event.instructions === 'string' ? { instructions: event.instructions } : {}),
      ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
      ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
    });
  } else if (event.type === 'auth_url') {
    send({ type: 'pi-auth-url', requestId, url: event.url, ...(typeof event.instructions === 'string' ? { instructions: event.instructions } : {}) });
  } else if (event.type === 'progress') {
    send({ type: 'pi-progress', requestId, message: String(event.message ?? '').slice(0, 500) });
  }
}

async function accountLogin(requestId, message) {
  const { key, oauth } = accountOAuth(message.provider);
  const controller = new AbortController();
  logins.set(requestId, controller);
  const interaction = {
    signal: controller.signal,
    notify(event) { accountEvent(requestId, event); },
    async prompt(request) {
      if (request?.type === 'select') return message.method === 'browser' ? 'browser' : 'device_code';
      throw new Error(`Unsupported account login prompt: ${String(request?.type)}`);
    },
  };
  try {
    const credential = await oauth.login(interaction, {
      agentName: 'Arxd',
      getDeviceId: () => typeof message.deviceId === 'string' && message.deviceId ? message.deviceId : globalThis.crypto.randomUUID(),
    });
    const accounts = await readAccounts();
    accounts[key] = credential;
    await writeAccounts(accounts);
    send({ type: 'pi-done', requestId, provider: key, status: accountStatus(credential) });
  } catch (error) {
    if (!logins.has(requestId)) send({ type: 'pi-cancelled', requestId });
    else send({ type: 'pi-error', requestId, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
  } finally {
    if (logins.get(requestId) === controller) logins.delete(requestId);
  }
}

async function accountToken(requestId, message) {
  const { key, oauth } = accountOAuth(message.provider);
  const accounts = await readAccounts();
  let credential = accounts[key];
  if (!credential) { send({ type: 'pi-token', requestId, token: null }); return; }
  if (typeof credential.expires === 'number' && credential.expires <= Date.now() + 60_000) {
    credential = await oauth.refresh(credential, AbortSignal.timeout(30_000));
    accounts[key] = credential;
    await writeAccounts(accounts);
  }
  const auth = await oauth.toAuth(credential);
  send({ type: 'pi-token', requestId, token: {
    ...(typeof auth.apiKey === 'string' ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers && typeof auth.headers === 'object' ? { headers: auth.headers } : {}),
    ...(typeof auth.baseUrl === 'string' ? { baseUrl: auth.baseUrl } : {}),
  } });
}

async function accountStatusRequest(requestId, message) {
  const { key, oauth } = accountOAuth(message.provider);
  const accounts = await readAccounts();
  const credential = accounts[key];
  send({ type: 'pi-status', requestId, status: {
    ...accountStatus(credential),
    ...(credential ? { loginLabel: oauth.name } : {}),
  } });
}

async function accountLogout(requestId, message) {
  const { key } = accountOAuth(message.provider);
  const accounts = await readAccounts();
  delete accounts[key];
  await writeAccounts(accounts);
  send({ type: 'pi-done', requestId, provider: key, status: { signedIn: false } });
}

function exchangeFor(executionId) {
  return (messages) => new Promise((resolve) => {
    const requestId = String(nextRequest++);
    pending.set(requestId, resolve);
    send({ type: 'exchange', executionId, requestId, messages });
  });
}

async function execute(message) {
  const executionId = message.executionId;
  if (typeof executionId !== 'string' || !executionId || executions.has(executionId)) throw new Error('Invalid execution identity');
  const request = message.request;
  if (!request || typeof request !== 'object' || !request.data || typeof request.data !== 'object') throw new Error('Invalid execution request');
  executions.add(executionId);
  try {
    await serveCodemodeRemote(request, exchangeFor(executionId), {
      wasm,
      maxInterruptBudget: 100_000,
      maxMemoryLimitBytes: 128 * 1024 * 1024,
    });
    send({ type: 'settled', executionId });
  } catch (error) {
    fail(executionId, error);
  } finally {
    executions.delete(executionId);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write('codemode-host: invalid JSON line\n');
    return;
  }
  try {
    if (message.type === 'reply') {
      const resolve = pending.get(message.requestId);
      if (!resolve) return;
      pending.delete(message.requestId);
      resolve(message.reply);
      return;
    }
    if (message.type === 'execute') {
      void execute(message).catch((error) => fail(message.executionId, error));
      return;
    }
    if (message.type === 'oauth-signin') {
      void signIn(message.requestId, message).catch((error) => send({ type: 'oauth-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'oauth-token') {
      void token(message.requestId, message).catch((error) => send({ type: 'oauth-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'oauth-signout') {
      const store = new McpOAuthCredentialStore();
      const removed = store.remove(message.name, message.url);
      send({ type: 'oauth-done', requestId: message.requestId, removed });
      return;
    }
    if (message.type === 'oauth-cancel') {
      const signal = oauth.get(message.requestId);
      oauth.delete(message.requestId);
      signal?.abort();
      send({ type: 'oauth-cancelled', requestId: message.requestId });
      return;
    }
    if (message.type === 'pi-login') {
      void accountLogin(message.requestId, message).catch((error) => send({ type: 'pi-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'pi-token') {
      void accountToken(message.requestId, message).catch((error) => send({ type: 'pi-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'pi-status') {
      void accountStatusRequest(message.requestId, message).catch((error) => send({ type: 'pi-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'pi-logout') {
      void accountLogout(message.requestId, message).catch((error) => send({ type: 'pi-error', requestId: message.requestId, error: String(error).slice(0, 2000) }));
      return;
    }
    if (message.type === 'pi-cancel') {
      const controller = logins.get(message.requestId);
      logins.delete(message.requestId);
      controller?.abort();
      send({ type: 'pi-cancelled', requestId: message.requestId });
      return;
    }
    if (message.type === 'stop') {
      for (const controller of logins.values()) controller.abort();
      logins.clear();
      for (const [requestId, resolve] of pending) {
        pending.delete(requestId);
        resolve({ type: 'stop' });
      }
      return;
    }
    process.stderr.write(`codemode-host: unknown message ${String(message.type)}\n`);
  } catch (error) {
    fail(message.executionId, error);
  }
});
input.on('close', () => {
  for (const controller of logins.values()) controller.abort();
  logins.clear();
  for (const [requestId, resolve] of pending) {
    pending.delete(requestId);
    resolve({ type: 'stop' });
  }
});

// Load the wasm before announcing readiness so a missing asset is an immediate,
// visible failure rather than a late sandbox error.
Promise.resolve(wasm).then(
  () => send({ type: 'ready', protocol: PROTOCOL }),
  (error) => {
    send({ type: 'ready', protocol: PROTOCOL, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
    process.exitCode = 1;
  },
);

// Keep the process alive until stdin closes; the remote server is event driven.
process.stdin.resume();

