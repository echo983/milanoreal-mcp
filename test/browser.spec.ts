import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { hash } from '@node-rs/argon2';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

test('real browser can reject and approve the HTTPS authorization form without an opaque Origin', async () => {
  const origin = 'https://mcp.example';
  const callback = 'https://client.example/callback';
  const dir = await mkdtemp(join(tmpdir(), 'milanoreal-browser-'));
  const config = parseConfig({ publicBaseUrl: origin, workspaceDir: dir, stateDir: dir, allowedRedirectUris: [callback] });
  const store = new Store(dir);
  const password = randomBytes(32).toString('base64url');
  store.setPassword(await hash(password));
  const { app, oauth } = createApp(config, store);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    // Present HTTPS to the browser without public DNS, certificates or external requests.
    // Forward the browser's actual Origin, cookies, body and the server's response headers.
    await context.route(`${origin}/**`, async route => {
      const request = route.request();
      const headers = await request.allHeaders();
      delete headers.host; delete headers['content-length'];
      const response = await fetch(local + new URL(request.url()).pathname + new URL(request.url()).search, {
        method: request.method(), headers, body: request.postData() ?? undefined, redirect: 'manual',
      });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await context.route('https://client.example/**', async route => {
      assert.equal((await route.request().allHeaders()).referer, undefined, 'Cross-origin callback must not leak the authorization page URL');
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Local callback intercepted' });
    });
    const registered = await fetch(local + '/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
    });
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    const browserErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text().replace(/https:\/\/[^\s"']+/g, value => {
        try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[URL]'; }
      }));
    });
    for (const decision of ['deny', 'approve']) {
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id, redirect_uri: callback, resource: origin + '/mcp', scope: 'mcp:access',
        state: 'browser-test-state', response_type: 'code', code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      const loaded = await page.goto(origin + '/oauth/authorize?' + query);
      assert.equal(loaded?.status(), 200);
      if (decision === 'approve') await page.locator('input[name="password"]').fill(password);
      const submitted = page.waitForResponse(response => response.url() === origin + '/oauth/approve' && response.request().method() === 'POST')
        .catch(error => { throw new Error(`${String(error)}; browser errors: ${browserErrors.join('; ')}`); });
      const [response] = await Promise.all([submitted, page.locator(`button[value="${decision}"]`).click()]);
      assert.equal((await response.request().allHeaders()).origin, origin, 'The form must preserve its same-site Origin');
      assert.equal(response.status(), 302);
      await page.waitForURL('https://client.example/**');
      const target = new URL(page.url());
      assert.equal(target.searchParams.get('state'), 'browser-test-state');
      assert.equal(target.searchParams.get('iss'), origin);
      if (decision === 'deny') {
        assert.equal(target.searchParams.get('error'), 'access_denied');
      } else {
        const exchanged = await fetch(local + '/oauth/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id, grant_type: 'authorization_code', code: target.searchParams.get('code')!,
            code_verifier: verifier, redirect_uri: callback, resource: origin + '/mcp' }),
        });
        assert.equal(exchanged.status, 200);
        await oauth.verifyAccessToken((await exchanged.json()).access_token);
      }
    }
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});
