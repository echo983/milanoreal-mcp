// Runs the production build with isolated state; never opens the owner's config or database.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../dist/store.js';
import { createApp } from '../dist/app.js';
import { parseConfig, assertOrdinaryUser } from '../dist/config.js';

assertOrdinaryUser();
const directory = await mkdtemp(join(tmpdir(), 'milanoreal-smoke-'));
let store, listener, client;
try {
  await mkdir(join(directory, 'workspace'));
  const callback = 'https://client.example/callback';
  const config = parseConfig({ publicBaseUrl: 'https://mcp.example', workspaceDir: 'workspace', stateDir: 'state', allowedRedirectUris: [callback] }, directory);
  const password = randomBytes(32).toString('base64url');
  store = new Store(config.stateDir);
  store.setPassword(await hash(password));
  const app = createApp(config, store).app;
  listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { ...init, redirect: 'manual' });
  const form = (path, fields, headers = {}) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields),
  });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/mcp', { method: 'POST' })).status, 401);
  const registration = await request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: 'Isolated production smoke', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const resource = 'https://mcp.example/mcp';
  const login = await request('/oauth/authorize?' + new URLSearchParams({ client_id, redirect_uri: callback, resource, scope: 'mcp:access', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }));
  assert.equal(login.status, 200);
  const html = await login.text();
  const approval = await form('/oauth/approve', { transaction: /name="transaction" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], decision: 'approve', password }, { cookie: login.headers.get('set-cookie').split(';')[0], origin: 'https://mcp.example' });
  assert.equal(approval.status, 302);
  const tokenResponse = await form('/oauth/token', { client_id, grant_type: 'authorization_code', code: new URL(approval.headers.get('location')).searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  client = new Client({ name: 'isolated-production-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 6);
  assert(!names.includes('connection_test'));
  const call = async (name, args) => {
    const result = await client.callTool({ name, ...(args ? { arguments: { args } } : {}) });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  await call('container_ping');
  await call('container_file_write', { path: 'project/PROGRESS.md', text: 'production smoke marker' });
  assert.match(JSON.stringify(await call('container_file_read', { path: 'project/PROGRESS.md' })), /production smoke marker/);
  assert.match(JSON.stringify(await call('container_files_list')), /project/);
  assert.match(JSON.stringify(await call('container_exec', { args: 'cat project/PROGRESS.md; id -un; node -p "6*7"' })), /production smoke marker/);
  await call('container_file_delete', { path: 'project' });
  const refreshed = await form('/oauth/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource });
  assert.equal(refreshed.status, 200);
  console.log('PASS: ordinary-user production build, isolated OAuth/refresh, authenticated SDK and all six tools');
} finally {
  if (client) await client.close();
  if (listener) await new Promise((resolve, reject) => { listener.close(error => error ? reject(error) : resolve()); listener.closeAllConnections(); });
  store?.close();
  await rm(directory, { recursive: true, force: true });
}
