import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import type { Request, Response } from 'express';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError, TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from './config.js';
import { Store, type Grant } from './store.js';

export const SCOPE = 'mcp:access';
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const random = (): string => randomBytes(32).toString('base64url');
const COOKIE = '__Host-milanoreal-authorize';
const html = (value: string): string => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!);
const equalHash = (value: string, expectedHash: string): boolean =>
  timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expectedHash, 'hex'));

type Pending = {
  clientId: string; redirect: string; state?: string; scopes: string[]; challenge: string;
  generation: number; expires: number;
};
type Login = Pending & { csrfHash: string; cookieHash: string };

/** A bounded in-memory window; eviction does not reset another source's live window. */
export class Limits {
  private windows = new Map<string, { count: number; until: number }>();
  constructor(private now: () => number) {}

  hit(key: string, maximum: number, seconds = 900): boolean {
    const now = this.now();
    for (const [k, v] of this.windows) if (v.until <= now) this.windows.delete(k);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= 2048) return false;
      window = { count: 0, until: now + seconds };
      this.windows.set(key, window);
    }
    if (window.count >= maximum) return false;
    window.count++;
    return true;
  }

  blocked(key: string, maximum: number): boolean {
    const row = this.windows.get(key);
    return !!row && row.until > this.now() && row.count >= maximum;
  }
}

export class OAuth implements OAuthServerProvider {
  readonly resource: string;
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly limits: Limits;
  private logins = new Map<string, Login>();
  private codes = new Map<string, Pending>();
  private verifying = 0;

  constructor(readonly config: Config, readonly store: Store,
    readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.resource = `${config.publicBaseUrl}/mcp`;
    this.limits = new Limits(now);
    this.clientsStore = {
      getClient: id => store.client(id, now()),
      registerClient: async metadata => {
        if (metadata.token_endpoint_auth_method !== 'none') {
          throw new InvalidClientMetadataError('Only explicit token_endpoint_auth_method=none is supported');
        }
        if (!metadata.redirect_uris.length || metadata.redirect_uris.some(uri => !config.allowedRedirectUris.includes(String(uri)))) {
          throw new InvalidClientMetadataError('Redirect URI is not in the configured allowlist');
        }
        const grants = metadata.grant_types ?? ['authorization_code'];
        const responses = metadata.response_types ?? ['code'];
        if (!grants.includes('authorization_code') || grants.some(g => !['authorization_code', 'refresh_token'].includes(g)) ||
          responses.length !== 1 || responses[0] !== 'code') {
          throw new InvalidClientMetadataError('Unsupported grant or response type');
        }
        if (metadata.scope && metadata.scope !== SCOPE) throw new InvalidClientMetadataError('Unsupported scope');
        const client: OAuthClientInformationFull = {
          client_id: random(), client_id_issued_at: now(),
          client_name: metadata.client_name?.slice(0, 100),
          redirect_uris: metadata.redirect_uris,
          token_endpoint_auth_method: 'none', grant_types: grants, response_types: ['code'], scope: SCOPE,
        };
        store.addClient(client, now());
        return client;
      },
    };
  }

  private prune(): void {
    const now = this.now();
    for (const cache of [this.logins, this.codes]) {
      for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
    }
  }

  private scopes(values?: string[]): string[] {
    if (values?.some(scope => scope !== SCOPE)) throw new InvalidScopeError('Unsupported scope');
    return [SCOPE];
  }

  private target(resource?: URL, required = false): void {
    if ((required && !resource) || (resource && resource.href !== this.resource)) {
      throw new InvalidTargetError('Resource must match this MCP endpoint');
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    this.target(params.resource, true);
    const scopes = this.scopes(params.scopes);
    if (!client.redirect_uris.includes(params.redirectUri) || !this.config.allowedRedirectUris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Redirect URI mismatch');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge');
    if (this.logins.size >= 128) throw new TooManyRequestsError('Too many pending logins');
    const id = random(), csrf = random(), cookie = random();
    this.logins.set(digest(id), {
      clientId: client.client_id, redirect: params.redirectUri, state: params.state,
      scopes, challenge: params.codeChallenge, generation: this.store.settings().generation,
      expires: this.now() + 600, csrfHash: digest(csrf), cookieHash: digest(cookie),
    });
    res.cookie(COOKIE, cookie, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600_000 });
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>授权连接 VPS</title>
      <body><main><h1>授权连接 VPS</h1><p>客户端：${html(client.client_name || '未命名客户端')}</p>
      <p>回调：${html(params.redirectUri)}</p><p>允许此连接执行命令，并操作专用系统用户有权限访问的文件。</p>
      <form method="post" action="${html(this.config.publicBaseUrl)}/oauth/approve">
      <input type="hidden" name="transaction" value="${id}"><input type="hidden" name="csrf" value="${csrf}">
      <label>强口令 <input name="password" type="password" autocomplete="current-password" maxlength="1024"></label>
      <button name="decision" value="approve">授权连接</button><button name="decision" value="deny">拒绝</button>
      </form></main></body></html>`);
  }

  async approve(req: Request, res: Response, source: string): Promise<void> {
    this.prune();
    const { transaction, csrf, decision, password } = req.body ?? {};
    if (typeof transaction !== 'string' || typeof csrf !== 'string' || !['approve', 'deny'].includes(decision)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const login = this.logins.get(digest(transaction));
    const cookie = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!login || !cookie || !equalHash(csrf, login.csrfHash) || !equalHash(cookie, login.cookieHash) ||
      login.generation !== this.store.settings().generation) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Login expired or browser verification failed' }); return;
    }
    if (decision === 'deny') {
      this.logins.delete(digest(transaction));
      this.callback(res, login, { error: 'access_denied' }); return;
    }
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    if (this.verifying >= 2 || this.limits.blocked(`password:${source}`, 5)) {
      res.set('Retry-After', '900').status(429).json({ error: 'too_many_requests' }); return;
    }
    this.verifying++;
    let valid = false;
    try {
      const settings = this.store.settings();
      valid = !!settings.password_hash && settings.generation === login.generation && await verify(settings.password_hash, password);
    } finally { this.verifying--; }
    if (!valid) {
      this.limits.hit(`password:${source}`, 5);
      res.status(401).type('text').send('口令不正确。请返回上一页重试。'); return;
    }
    // Password verification is asynchronous. Recheck one-time state and generation afterwards.
    if (this.logins.get(digest(transaction)) !== login || login.expires <= this.now() || this.codes.size >= 128) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Restart authorization' }); return;
    }
    const code = random();
    this.store.transaction(() => {
      if (this.store.settings().generation !== login.generation) throw new InvalidGrantError('Authorization was revoked');
      this.store.approveClient(login.clientId, this.now());
      this.logins.delete(digest(transaction));
      this.codes.set(digest(code), { ...login, expires: this.now() + 60 });
    });
    this.callback(res, login, { code });
  }

  private callback(res: Response, pending: Pending, values: Record<string, string>): void {
    const target = new URL(pending.redirect);
    for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
    target.searchParams.set('iss', this.config.publicBaseUrl);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    res.redirect(302, target.href);
  }

  private code(client: OAuthClientInformationFull, value: string): Pending {
    this.prune();
    const code = this.codes.get(digest(value));
    if (!code || code.clientId !== client.client_id || code.generation !== this.store.settings().generation) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, value: string): Promise<string> {
    return this.code(client, value).challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, value: string, _verifier?: string,
    redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const code = this.code(client, value);
    this.target(resource, true);
    if (redirectUri !== code.redirect || !this.config.allowedRedirectUris.includes(code.redirect)) {
      throw new InvalidGrantError('Redirect URI mismatch');
    }
    this.codes.delete(digest(value));
    return this.store.transaction(() => {
      if (code.generation !== this.store.settings().generation) throw new InvalidGrantError('Authorization revoked');
      const grant: Grant = {
        id: random(), client_id: client.client_id, generation: code.generation,
        resource: this.resource, scope: SCOPE, expires_at: this.now() + 90 * 86_400, revoked: 0,
      };
      this.store.insertGrant(grant);
      return this.issue(grant, client.grant_types?.includes('refresh_token') ?? false);
    });
  }

  private issue(grant: Grant, refresh: boolean): OAuthTokens {
    const access = random(), refreshToken = refresh ? random() : undefined;
    const expires = Math.min(this.now() + 3600, grant.expires_at);
    this.store.insertToken({ hash: digest(access), kind: 'access', grant_id: grant.id, expires_at: expires, used: 0 });
    if (refreshToken) this.store.insertToken({
      hash: digest(refreshToken), kind: 'refresh', grant_id: grant.id, expires_at: grant.expires_at, used: 0,
    });
    return { access_token: access, token_type: 'Bearer', expires_in: expires - this.now(), refresh_token: refreshToken, scope: SCOPE };
  }

  private active(grant?: Grant): grant is Grant {
    return !!grant && !grant.revoked && grant.expires_at > this.now() &&
      grant.generation === this.store.settings().generation && grant.resource === this.resource && grant.scope === SCOPE;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, value: string,
    scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.target(resource);
    this.scopes(scopes);
    if (!client.grant_types?.includes('refresh_token')) throw new InvalidGrantError('Client has no refresh grant');
    const result = this.store.transaction(() => {
      const token = this.store.token(digest(value));
      const grant = token && this.store.grant(token.grant_id);
      if (!token || token.kind !== 'refresh' || token.expires_at <= this.now() || !this.active(grant) || grant.client_id !== client.client_id) {
        return undefined;
      }
      if (token.used) {
        this.store.revokeGrant(grant.id);
        return undefined; // Commit replay revocation instead of throwing and rolling it back.
      }
      this.store.consumeRefresh(token.hash);
      return this.issue(grant, true);
    });
    if (!result) throw new InvalidGrantError('Invalid, expired or replayed refresh token');
    return result;
  }

  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const token = this.store.token(digest(value));
    const grant = token && this.store.grant(token.grant_id);
    if (!token || token.kind !== 'access' || token.expires_at <= this.now() || !this.active(grant)) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return { token: value, clientId: grant.client_id, scopes: [SCOPE], expiresAt: token.expires_at, resource: new URL(grant.resource) };
  }
}
