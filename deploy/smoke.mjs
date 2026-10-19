// Runs the production build with isolated state; never opens the owner's config or database.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, cp, realpath, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--recovery'), 'Usage: node deploy/smoke.mjs [--recovery]');
const recovery = process.argv[2] === '--recovery';
const run = promisify(execFile);
const checksum = async path => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
const directory = await mkdtemp(join(tmpdir(), 'milanoreal-smoke-'));
let store, listener, client;
const stop = async () => {
  if (client) { await client.close(); client = undefined; }
  if (listener) {
    await new Promise((resolve, reject) => { listener.close(error => error ? reject(error) : resolve()); listener.closeAllConnections(); });
    listener = undefined;
  }
  store?.close(); store = undefined;
};
try {
  let live = join(directory, 'live');
  await mkdir(join(live, 'workspace'), { recursive: true, mode: 0o700 });
  const callback = 'https://client.example/callback';
  const configInput = { publicBaseUrl: 'https://mcp.example', workspaceDir: 'workspace', stateDir: 'state', allowedRedirectUris: [callback] };
  let config = parseConfig(configInput, live);
  await writeFile(join(live, 'config.json'), JSON.stringify(configInput), { mode: 0o600 });
  const password = randomBytes(32).toString('base64url');
  store = new Store(config.stateDir);
  store.setPassword(await hash(password));
  let base;
  const start = async (factory = createApp) => {
    const app = factory(config, store).app;
    listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${listener.address().port}`;
  };
  await start();
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
  const resource = 'https://mcp.example/mcp';
  const authorize = async () => {
    const verifier = randomBytes(32).toString('base64url');
    const login = await request('/oauth/authorize?' + new URLSearchParams({ client_id, redirect_uri: callback, resource, scope: 'mcp:access', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }));
    assert.equal(login.status, 200);
    const html = await login.text();
    const approval = await form('/oauth/approve', { transaction: /name="transaction" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], decision: 'approve', password }, { cookie: login.headers.get('set-cookie').split(';')[0], origin: 'https://mcp.example' });
    assert.equal(approval.status, 302);
    const tokenResponse = await form('/oauth/token', { client_id, grant_type: 'authorization_code', code: new URL(approval.headers.get('location')).searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource });
    assert.equal(tokenResponse.status, 200);
    return tokenResponse.json();
  };
  let tokens = await authorize();
  const connect = async () => {
    client = new Client({ name: 'isolated-production-smoke', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  };
  await connect();
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
  if (!recovery) await call('container_file_delete', { path: 'project' });
  const consumedRefresh = tokens.refresh_token;
  const refreshed = await form('/oauth/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource });
  assert.equal(refreshed.status, 200);
  tokens = await refreshed.json();
  if (recovery) {
    // The only archived state is this script's temporary random-password fixture.
    await stop();
    const source = fileURLToPath(new URL('../', import.meta.url));
    for (const name of ['dist', 'node_modules', 'package.json', 'package-lock.json']) {
      await cp(await realpath(join(source, name)), join(live, 'app', name), { recursive: true });
    }
    const archive = join(directory, 'backup.tar');
    await run('tar', ['-C', live, '-cpf', archive, 'config.json', 'state', 'workspace', 'app']);
    await chmod(archive, 0o600);
    const digest = await checksum(archive);
    await writeFile(join(directory, 'backup.sha256'), digest + '\n', { mode: 0o600 });
    await rm(live, { recursive: true });
    live = join(directory, 'restored');
    await mkdir(live, { mode: 0o700 });
    assert.equal(await checksum(archive), (await readFile(join(directory, 'backup.sha256'), 'utf8')).trim());
    await run('tar', ['-C', live, '-xpf', archive]);
    const appRoot = join(live, 'app');
    const fromRestored = name => import(pathToFileURL(join(appRoot, 'dist', name)).href);
    const [{ loadConfig }, { Store: RestoredStore }, { createApp: restoredApp }] = await Promise.all([
      fromRestored('config.js'), fromRestored('store.js'), fromRestored('app.js'),
    ]);
    config = await loadConfig(join(live, 'config.json'));
    assert.equal(config.workspaceDir, join(live, 'workspace'));
    assert.equal((await stat(config.stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(config.stateDir, 'state.sqlite'))).mode & 0o777, 0o600);
    store = new RestoredStore(config.stateDir);
    assert.equal(Object.values(store.db.prepare('PRAGMA integrity_check').get())[0], 'ok');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    await start(restoredApp);
    await connect();
    await call('container_ping');
    assert.match(JSON.stringify(await call('container_file_read', { path: 'project/PROGRESS.md' })), /production smoke marker/);
    await call('container_exec', { args: 'test -f project/PROGRESS.md; node -p "6*7"' });
    await client.close(); client = undefined;
    const restoredRefresh = await form('/oauth/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource });
    assert.equal(restoredRefresh.status, 200);
    tokens = await restoredRefresh.json();
    // Rotation history must survive restoration: replay revokes the restored grant.
    const replay = await form('/oauth/token', { client_id, grant_type: 'refresh_token', refresh_token: consumedRefresh, resource });
    assert.equal(replay.status, 400);
    assert.equal((await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    tokens = await authorize(); // Restored password and approved client remain usable.
    store.revokeAll(); // Isolated data only; same mutation used by the admin command.
    assert.equal((await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    assert.equal((await form('/oauth/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource })).status, 400);
    tokens = await authorize();
    await connect();
    await call('container_file_delete', { path: 'project' });
    console.log('PASS: isolated archive/checksum/restore, restored build/dependencies/config, SQLite integrity/permissions, project files, access/refresh, replay detection, revocation and reauthorization');
  } else {
    console.log('PASS: ordinary-user production build, isolated OAuth/refresh, authenticated SDK and all six tools');
  }
} finally {
  try { await stop(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
