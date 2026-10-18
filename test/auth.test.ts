import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { Request, Response } from 'express';
import { hash } from '@node-rs/argon2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { parseConfig, assertOrdinaryUser } from '../src/config.js';
import { Store } from '../src/store.js';

const password = 'local-test-only-random-strong-password';
const passwordHash = await hash(password);
const redirectUri = 'https://client.example/callback';
const resource = 'https://mcp.example/mcp';
const scope = 'mcp:access';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'milanoreal-test-'));
  await mkdir(join(dir, 'workspace'));
  const config = parseConfig({ publicBaseUrl: 'https://mcp.example', workspaceDir: 'workspace', stateDir: 'state', allowedRedirectUris: [redirectUri] }, dir);
  let clock = Math.floor(Date.now() / 1000);
  let store = new Store(config.stateDir);
  store.setPassword(passwordHash);
  let instance = createApp(config, store, () => clock);
  let listener: Server;
  let base = '';
  const start = async () => {
    listener = await new Promise<Server>(resolve => {
      const server = instance.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const address = listener.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  };
  const stop = () => new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve()); listener.closeAllConnections();
  });
  await start();
  t.after(async () => { await stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (path: string, init?: RequestInit) => fetch(base + path, { ...init, redirect: 'manual' });
  const form = (path: string, fields: Record<string, string>, headers?: Record<string, string>) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields),
  });
  const register = async (extra: Record<string, unknown> = {}) => {
    const response = await request('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        client_name: 'Test client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra,
      }),
    });
    return { response, data: await response.json() };
  };
  const begin = async (clientId: string, extra: Record<string, string> = {}) => {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, resource, scope, response_type: 'code', state: 'opaque-state<&',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...extra,
    });
    const response = await request(`/oauth/authorize?${query}`);
    const body = await response.text();
    return {
      response, body, verifier,
      cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
      transaction: /name="transaction" value="([^"]+)"/.exec(body)?.[1] ?? '',
      csrf: /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '',
    };
  };
  const approve = (login: Awaited<ReturnType<typeof begin>>, inputPassword = password, csrf = login.csrf) =>
    form('/oauth/approve', { transaction: login.transaction, csrf, decision: 'approve', password: inputPassword }, { cookie: login.cookie });
  const exchange = (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
    form('/oauth/token', { client_id: clientId, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, resource, ...extra });
  const connect = async () => {
    const registered = await register(); assert.equal(registered.response.status, 201);
    const clientId = registered.data.client_id as string;
    const login = await begin(clientId); assert.equal(login.response.status, 200);
    const approval = await approve(login); assert.equal(approval.status, 302);
    const location = new URL(approval.headers.get('location')!);
    assert.equal(location.searchParams.get('iss'), 'https://mcp.example');
    assert.equal(location.searchParams.get('state'), 'opaque-state<&');
    const code = location.searchParams.get('code')!;
    const tokenResponse = await exchange(clientId, code, login.verifier); assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    return { clientId, tokens, code, login };
  };
  const refresh = (clientId: string, token: string, extra: Record<string, string> = {}) => form('/oauth/token', {
    client_id: clientId, grant_type: 'refresh_token', refresh_token: token, resource, ...extra,
  });
  return {
    config, request, form, register, begin, approve, exchange, connect, refresh,
    get base() { return base; }, get store() { return store; }, get oauth() { return instance.oauth; },
    advance(seconds: number) { clock += seconds; },
    async restart() {
      await stop(); store.close(); store = new Store(config.stateDir);
      instance = createApp(config, store, () => clock); await start();
    },
  };
}

test('configuration is HTTPS-only and startup does not fall back to anonymous access', async t => {
  assert.throws(() => assertOrdinaryUser(0));
  assert.doesNotThrow(() => assertOrdinaryUser(1000));
  for (const publicBaseUrl of ['http://mcp.example', 'https://mcp.example/path', 'https://user:pass@mcp.example']) {
    assert.throws(() => parseConfig({ publicBaseUrl, stateDir: 'state', workspaceDir: 'work' }));
  }
  const dir = await mkdtemp(join(tmpdir(), 'milanoreal-uninitialized-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  try {
    const config = parseConfig({ publicBaseUrl: 'https://mcp.example', stateDir: dir, workspaceDir: dir });
    assert.throws(() => createApp(config, store), /Initialize/);
    assert.equal((await stat(join(dir, 'state.sqlite'))).mode & 0o777, 0o600);
  } finally { store.close(); }
});

test('real SDK client authenticates and invokes all six VPS tools', async t => {
  const f = await fixture(t);
  const unauthorized = await f.request('/mcp', { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
  const metadata = await f.request('/.well-known/oauth-authorization-server');
  const data = await metadata.json();
  assert.equal(data.issuer, 'https://mcp.example');
  assert.equal(data.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(data.token_endpoint_auth_methods_supported, ['none']);
  assert.notEqual(metadata.headers.get('access-control-allow-origin'), '*');
  const { tokens } = await f.connect();
  const client = new Client({ name: 'local-auth-verification', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  }));
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), [
      'container_ping', 'container_exec', 'container_file_write', 'container_files_list',
      'container_file_read', 'container_file_delete',
    ].sort());
    const call = async (name: string, args?: object) => {
      const result = await client.callTool({ name, ...(args ? { arguments: { args } } : {}) });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result;
    };
    assert.match(JSON.stringify(await call('container_ping')), /workspace/);
    await call('container_file_write', { path: 'hello.txt', text: 'persistent hello' });
    assert.match(JSON.stringify(await call('container_file_read', { path: 'hello.txt' })), /persistent hello/);
    assert.match(JSON.stringify(await call('container_files_list')), /hello.txt/);
    assert.match(JSON.stringify(await call('container_exec', { args: 'cat hello.txt' })), /persistent hello/);
    await client.close();
    await f.restart();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }));
    assert.match(JSON.stringify(await call('container_file_read', { path: 'hello.txt' })), /persistent hello/);
    await call('container_file_delete', { path: 'hello.txt' });
    assert.equal((await client.callTool({ name: 'container_exec', arguments: { args: { args: 'exit 7' } } })).isError, true);
  } finally { await client.close(); }
});

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try { return await readFile(path, 'utf8'); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    await delay(10);
  }
  throw new Error('Timed out waiting for test command marker');
}

test('independent stateless HTTP requests share the same two execution slots', async t => {
  const f = await fixture(t);
  const { tokens } = await f.connect();
  const call = (command: string) => f.request('/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: command, method: 'tools/call', params: { name: 'container_exec', arguments: { args: { args: command, timeout: 5000 } } } }),
  }).then(response => response.json());
  const first = call('touch first; for i in {1..100}; do test -f release && exit 0; sleep .02; done; exit 8');
  const second = call('touch second; for i in {1..100}; do test -f release && exit 0; sleep .02; done; exit 8');
  try {
    await Promise.all(['first', 'second'].map(name => waitForFile(join(f.config.workspaceDir, name))));
    const busy = await call('true');
    assert.equal(busy.result.isError, true);
    assert.match(JSON.stringify(busy), /busy/);
  } finally { await writeFile(join(f.config.workspaceDir, 'release'), ''); }
  for (const result of await Promise.all([first, second])) assert.equal(result.result.isError, false);
});

test('disconnecting a command request neither repeats it nor claims to stop it', async t => {
  const f = await fixture(t);
  const { tokens } = await f.connect();
  const abort = new AbortController();
  const pending = f.request('/mcp', {
    method: 'POST', signal: abort.signal,
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'container_exec', arguments: { args: { args: 'touch started; sleep .2; printf once >> result' } } } }),
  });
  await waitForFile(join(f.config.workspaceDir, 'started'));
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(await waitForFile(join(f.config.workspaceDir, 'result')), 'once');
});

test('registration rejects unsupported authentication, scopes, grants and untrusted redirects', async t => {
  const f = await fixture(t);
  for (const extra of [
    { token_endpoint_auth_method: 'client_secret_basic' }, { token_endpoint_auth_method: undefined },
    { redirect_uris: ['https://evil.example/callback'] }, { grant_types: ['client_credentials'] }, { scope: 'root' },
  ]) assert.equal((await f.register(extra)).response.status, 400);
  assert.equal((await f.request('/healthz', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/oauth/approve', { method: 'POST', headers: { origin: 'null' } })).status, 403);
  // Node fetch ignores Host overrides; use the HTTP client to exercise the actual header.
  const status = await new Promise<number>(resolve => {
    const req = httpRequest(`${f.base}/healthz`, { headers: { host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode!);
    });
    req.end();
  });
  assert.equal(status, 400);
});

test('login validates browser binding and password; untrusted display names are escaped', async t => {
  const f = await fixture(t);
  const { data } = await f.register({ client_name: '<script>alert(1)</script>' });
  const login = await f.begin(data.client_id);
  assert.match(login.body, /&lt;script&gt;/);
  assert.doesNotMatch(login.body, /<script>/);
  assert.equal((await f.approve(login, password, 'wrong-csrf')).status, 400);
  assert.equal((await f.approve({ ...login, cookie: '' })).status, 400);
  assert.equal((await f.approve(login, 'wrong-password')).status, 401);
  const success = await f.approve(login);
  assert.equal(success.status, 302);
  assert.equal((await f.approve(login)).status, 400);
});

test('authorization errors preserve issuer and state, but never redirect to an unregistered callback', async t => {
  const f = await fixture(t);
  const { data } = await f.register();
  const invalidRequests: Record<string, string>[] = [{ scope: 'root' }, { code_challenge_method: 'plain' }, { resource: 'https://evil.example/mcp' }];
  for (const extra of invalidRequests) {
    const response = (await f.begin(data.client_id, extra)).response;
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get('location')!);
    assert.equal(target.origin, new URL(redirectUri).origin);
    assert.equal(target.searchParams.get('iss'), 'https://mcp.example');
    assert.equal(target.searchParams.get('state'), 'opaque-state<&');
    assert(target.searchParams.has('error'));
  }
  assert.equal((await f.begin(data.client_id, { redirect_uri: 'https://evil.example/callback' })).response.status, 400);
});

test('authorization code is bound to verifier, client, callback, resource and one-time use', async t => {
  const f = await fixture(t);
  const { data: first } = await f.register();
  const { data: second } = await f.register();
  const login = await f.begin(first.client_id);
  const response = await f.approve(login);
  const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
  for (const [clientId, verifier, extra] of [
    [first.client_id, randomBytes(32).toString('base64url'), {}],
    [second.client_id, login.verifier, {}],
    [first.client_id, login.verifier, { redirect_uri: 'https://evil.example/callback' }],
    [first.client_id, login.verifier, { resource: 'https://evil.example/mcp' }],
  ] as const) assert.equal((await f.exchange(clientId, code, verifier, extra)).status, 400);
  const results = await Promise.all([f.exchange(first.client_id, code, login.verifier), f.exchange(first.client_id, code, login.verifier)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
});

test('refresh is client/resource bound; reuse revokes the entire affected grant', async t => {
  const f = await fixture(t);
  const { clientId, tokens } = await f.connect();
  const { data: other } = await f.register();
  assert.equal((await f.refresh(other.client_id, tokens.refresh_token)).status, 400);
  assert.equal((await f.refresh(clientId, tokens.refresh_token, { resource: 'https://evil.example/mcp' })).status, 400);
  const renewed = await f.refresh(clientId, tokens.refresh_token); assert.equal(renewed.status, 200);
  const next = await renewed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  await f.oauth.verifyAccessToken(next.access_token);
  assert.equal((await f.refresh(clientId, tokens.refresh_token)).status, 400);
  await assert.rejects(f.oauth.verifyAccessToken(next.access_token));
  assert.equal((await f.refresh(clientId, next.refresh_token)).status, 400);
});

test('separate administrator invalidates active tokens, pending approvals and unexchanged codes', async t => {
  const f = await fixture(t);
  const connected = await f.connect();
  const pending = await f.begin(connected.clientId);
  const approved = await f.begin(connected.clientId);
  const response = await f.approve(approved);
  const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
  const admin = new Store(f.config.stateDir);
  admin.revokeAll(); admin.close();
  await assert.rejects(f.oauth.verifyAccessToken(connected.tokens.access_token));
  assert.equal((await f.refresh(connected.clientId, connected.tokens.refresh_token)).status, 400);
  assert.equal((await f.approve(pending)).status, 400);
  assert.equal((await f.exchange(connected.clientId, code, approved.verifier)).status, 400);
  assert(f.store.client(connected.clientId));
});

test('password changes from a separate administrator are observed by the running server', async t => {
  const f = await fixture(t);
  const { data } = await f.register();
  const pending = await f.begin(data.client_id);
  // Replace the hash from a second DB connection; the running server must reread it.
  const admin = new Store(f.config.stateDir);
  admin.setPassword(await hash('replacement-test-password-long-enough')); admin.close();
  assert.equal((await f.approve(pending)).status, 400);
  const fresh = await f.begin(data.client_id);
  assert.equal((await f.approve(fresh)).status, 401);
  assert.equal((await f.approve(fresh, 'replacement-test-password-long-enough')).status, 302);
});

test('revocation during asynchronous password verification cannot issue an authorization code', async t => {
  const f = await fixture(t);
  const { data } = await f.register();
  const login = await f.begin(data.client_id);
  const req = { body: { transaction: login.transaction, csrf: login.csrf, decision: 'approve', password }, headers: { cookie: login.cookie } } as Request;
  const response = {} as Response; // A successful or early-failure response would fail this test.
  const inFlight = f.oauth.approve(req, response, '127.0.0.1');
  const rejection = assert.rejects(inFlight, /Authorization was revoked/);
  const admin = new Store(f.config.stateDir);
  admin.revokeAll(); admin.close();
  await rejection;
});

test('simultaneous refresh reuse revokes the winning token too', async t => {
  const f = await fixture(t);
  const { clientId, tokens } = await f.connect();
  const results = await Promise.all([
    f.refresh(clientId, tokens.refresh_token), f.refresh(clientId, tokens.refresh_token),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const winner = await results.find(r => r.status === 200)!.json();
  await assert.rejects(f.oauth.verifyAccessToken(winner.access_token));
});

test('persistent tokens survive restart; incomplete logins do not', async t => {
  const f = await fixture(t);
  const { clientId, tokens } = await f.connect();
  const login = await f.begin(clientId);
  await f.restart();
  await f.oauth.verifyAccessToken(tokens.access_token);
  assert.equal((await f.refresh(clientId, tokens.refresh_token)).status, 200);
  assert.equal((await f.approve(login)).status, 400);
});

test('expiry and authorization absolute lifetime are enforced without waiting', async t => {
  const f = await fixture(t);
  const { clientId, tokens } = await f.connect();
  const login = await f.begin(clientId);
  const approval = await f.approve(login);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  f.advance(61);
  assert.equal((await f.exchange(clientId, code, login.verifier)).status, 400);
  f.advance(3600);
  await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
  const refreshed = await f.refresh(clientId, tokens.refresh_token); assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  f.advance(90 * 86_400);
  assert.equal((await f.refresh(clientId, next.refresh_token)).status, 400);
});

test('unapproved registration churn does not evict an approved client', async t => {
  const f = await fixture(t);
  const { clientId } = await f.connect();
  for (let i = 0; i < 140; i++) {
    await f.oauth.clientsStore.registerClient!({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' });
  }
  assert(f.store.client(clientId));
  const count = f.store.db.prepare('SELECT COUNT(*) AS count FROM clients WHERE approved_at IS NULL').get() as { count: number };
  assert.equal(count.count, 128);
});

test('unapproved client expiry is enforced even without new registration or cleanup', async t => {
  const f = await fixture(t);
  const approved = await f.connect();
  const pending = await f.register();
  f.advance(86_401);
  assert.equal(await f.oauth.clientsStore.getClient(pending.data.client_id), undefined);
  assert(await f.oauth.clientsStore.getClient(approved.clientId));
});

test('failed password attempts are limited even when the next password is correct', async t => {
  const f = await fixture(t);
  const { data } = await f.register();
  const login = await f.begin(data.client_id);
  for (let i = 0; i < 5; i++) assert.equal((await f.approve(login, 'incorrect')).status, 401);
  assert.equal((await f.approve(login)).status, 429);
});
