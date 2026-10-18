import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export type Settings = { password_hash: string | null; generation: number };
export type Grant = {
  id: string; client_id: string; generation: number; resource: string;
  scope: string; expires_at: number; revoked: number;
};
export type TokenRow = {
  hash: string; kind: 'access' | 'refresh'; grant_id: string; expires_at: number; used: number;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, 'state.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error('Unsupported database schema version');
    }
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT, generation INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO settings VALUES (1, NULL, 0);
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, approved_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
          generation INTEGER NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
          expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tokens (
          hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
          grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
        CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens(expires_at);
        CREATE INDEX IF NOT EXISTS grants_expiry ON grants(expires_at);
        PRAGMA user_version=1;
      `);
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  settings(): Settings {
    return this.db.prepare('SELECT password_hash, generation FROM settings WHERE id=1').get() as Settings;
  }

  setPassword(passwordHash: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE settings SET password_hash=?, generation=generation+1 WHERE id=1').run(passwordHash);
    });
  }

  revokeAll(): void {
    this.transaction(() => { this.db.prepare('UPDATE settings SET generation=generation+1 WHERE id=1').run(); });
  }

  client(id: string, now = Math.floor(Date.now() / 1000)): OAuthClientInformationFull | undefined {
    const row = this.db.prepare(`SELECT metadata FROM clients WHERE id=?
      AND (approved_at IS NOT NULL OR created_at>?)`).get(id, now - 86_400) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) as OAuthClientInformationFull : undefined;
  }

  addClient(client: OAuthClientInformationFull, now: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM clients WHERE approved_at IS NULL AND created_at<=?').run(now - 86_400);
      // Keep at most 127 existing unapproved registrations before adding this one.
      this.db.prepare(`DELETE FROM clients WHERE id IN (
        SELECT id FROM clients WHERE approved_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 127
      )`).run();
      this.db.prepare('INSERT INTO clients(id,metadata,created_at) VALUES (?,?,?)').run(client.client_id, JSON.stringify(client), now);
    });
  }

  approveClient(id: string, now: number): void {
    const result = this.db.prepare(`UPDATE clients SET approved_at=COALESCE(approved_at,?) WHERE id=?
      AND (approved_at IS NOT NULL OR created_at>?)`).run(now, id, now - 86_400);
    if (result.changes !== 1) throw new Error('Client registration no longer exists');
  }

  insertGrant(grant: Grant): void {
    this.db.prepare(`INSERT INTO grants(id,client_id,generation,resource,scope,expires_at,revoked)
      VALUES (?,?,?,?,?,?,?)`).run(grant.id, grant.client_id, grant.generation, grant.resource, grant.scope, grant.expires_at, grant.revoked);
  }

  grant(id: string): Grant | undefined {
    return this.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as Grant | undefined;
  }

  insertToken(token: TokenRow): void {
    this.db.prepare('INSERT INTO tokens(hash,kind,grant_id,expires_at,used) VALUES (?,?,?,?,?)')
      .run(token.hash, token.kind, token.grant_id, token.expires_at, token.used);
  }

  token(hash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE hash=?').get(hash) as TokenRow | undefined;
  }

  consumeRefresh(hash: string): void {
    this.db.prepare('UPDATE tokens SET used=1 WHERE hash=?').run(hash);
  }

  revokeGrant(id: string): void {
    this.db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(id);
  }

  cleanup(now: number): void {
    this.transaction(() => {
      // Keep consumed refresh hashes until their grant expires to detect replay.
      this.db.prepare('DELETE FROM tokens WHERE hash IN (SELECT hash FROM tokens WHERE expires_at<=? LIMIT 500)').run(now);
      this.db.prepare('DELETE FROM grants WHERE id IN (SELECT id FROM grants WHERE expires_at<=? LIMIT 100)').run(now);
    });
  }

  close(): void { this.db.close(); }
}
