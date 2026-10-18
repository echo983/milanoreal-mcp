import express, { type ErrorRequestHandler, type Request } from 'express';
import { isIP } from 'node:net';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from './config.js';
import { OAuth, SCOPE } from './oauth.js';
import { Store } from './store.js';
import { Executor } from './execution.js';
import { Filesystem } from './filesystem.js';
import { instructions, registerTools } from './tools.js';

function source(req: Request): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const forwarded = req.get('CF-Connecting-IP');
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && forwarded && isIP(forwarded)) return forwarded;
  return peer;
}

export function createApp(config: Config, store: Store, now?: () => number) {
  if (!store.settings().password_hash) throw new Error('Initialize a strong password with the admin command first');
  const oauth = new OAuth(config, store, now);
  const executor = new Executor(config.workspaceDir);
  const files = new Filesystem(config.workspaceDir);
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');
  const origins = new Set([config.publicBaseUrl, ...config.allowedRedirectUris.map(uri => new URL(uri).origin)]);

  app.use((req, res, next) => {
    const host = req.get('host');
    if (host !== new URL(config.publicBaseUrl).host && !/^127\.0\.0\.1(?::\d+)?$/.test(host ?? '')) {
      res.status(400).json({ error: 'invalid_host' }); return;
    }
    const origin = req.get('origin');
    if (origin && !origins.has(origin)) { res.status(403).json({ error: 'invalid_origin' }); return; }
    // SDK OAuth handlers include CORS. Narrow their wildcard header to our checked origin.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name,
      name.toLowerCase() === 'access-control-allow-origin' ? (origin ?? config.publicBaseUrl) : value);
    res.set('Vary', 'Origin');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    // no-referrer makes browsers send Origin:null on HTML form POSTs.
    // Preserve same-origin submission while omitting referrers to OAuth callbacks.
    res.set('Referrer-Policy', 'same-origin');
    // Chromium also applies form-action to redirects after form submission.
    const formTargets = [...origins].filter(value => value !== config.publicBaseUrl).join(' ');
    res.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${formTargets}; frame-ancestors 'none'; base-uri 'none'`);
    next();
  });

  // Parse with bounded sizes before the SDK's parsers. Later parsers reuse parsed bodies.
  app.use('/oauth', express.json({ limit: '16kb', strict: true }));
  app.use('/oauth', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 32 }));
  app.use('/oauth', (req, res, next) => {
    const budget = req.path === '/register' ? 20 : 100;
    if (!oauth.limits.hit(`request:${req.path}:${source(req)}`, budget)) {
      res.set('Retry-After', '900').status(429).json({ error: 'too_many_requests' }); return;
    }
    next();
  });

  const metadata: OAuthMetadata = {
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${config.publicBaseUrl}/oauth/token`,
    registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true,
  };
  const resourceMetadata = {
    resource: oauth.resource, authorization_servers: [config.publicBaseUrl], scopes_supported: [SCOPE],
  };
  app.get('/.well-known/oauth-protected-resource', (_req, res) => { res.json(resourceMetadata); });
  app.use(mcpAuthMetadataRouter({ oauthMetadata: metadata, resourceServerUrl: new URL(oauth.resource), scopesSupported: [SCOPE] }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  // SDK-generated authorization error redirects also need issuer identification.
  app.use('/oauth/authorize', (req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = ((statusOrUrl: number | string, url?: string) => {
      const target = new URL(typeof statusOrUrl === 'string' ? statusOrUrl : url!);
      target.searchParams.set('iss', config.publicBaseUrl);
      const state: unknown = req.method === 'POST' ? req.body?.state : req.query.state;
      if (typeof state === 'string') target.searchParams.set('state', state);
      return redirect(typeof statusOrUrl === 'number' ? statusOrUrl : 302, target.href);
    }) as typeof res.redirect;
    next();
  });
  app.use('/oauth/authorize', authorizationHandler({ provider: oauth, rateLimit: false }));
  app.post('/oauth/approve', async (req, res) => { await oauth.approve(req, res, source(req)); });
  app.use('/oauth/register', clientRegistrationHandler({ clientsStore: oauth.clientsStore, rateLimit: false, clientIdGeneration: false }));
  app.use('/oauth/token', tokenHandler({ provider: oauth, rateLimit: false }));

  app.use('/mcp', requireBearerAuth({
    verifier: oauth, requiredScopes: [SCOPE], expectedResource: new URL(oauth.resource),
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
  }));
  app.use('/mcp', express.json({ limit: '8mb', strict: true }));
  app.post('/mcp', async (req, res, next) => {
    const server = new McpServer({ name: 'milanoreal-mcp', version: '0.1.0-preview.1' }, {
      instructions: instructions(config.workspaceDir),
    });
    registerTools(server, executor, files);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      void server.close().catch(() => {});
    };
    res.once('finish', dispose);
    res.once('close', dispose);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) { dispose(); next(error); }
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).end(); });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof OAuthError) { res.status(400).json(error.toResponseObject()); return; }
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    const safeStatus = status >= 400 && status < 500 ? status : 500;
    res.status(safeStatus).json({ error: safeStatus === 500 ? 'server_error' : 'invalid_request' });
  };
  app.use(errors);
  return { app, oauth };
}
