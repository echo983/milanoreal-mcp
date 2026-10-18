import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  publicBaseUrl: z.string().url(),
  listenPort: z.number().int().min(1).max(65535).default(3000),
  workspaceDir: z.string().min(1),
  stateDir: z.string().min(1),
  allowedRedirectUris: z.array(z.string().url()).max(16).default([]),
}).strict();

export type Config = z.infer<typeof schema>;

export function parseConfig(input: unknown, baseDir = process.cwd()): Config {
  const config = schema.parse(input);
  const base = new URL(config.publicBaseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new Error('publicBaseUrl must be an HTTPS origin without a path, query or credentials');
  }
  for (const value of config.allowedRedirectUris) {
    const uri = new URL(value);
    if (uri.protocol !== 'https:' || uri.hash || uri.username || uri.password) {
      throw new Error('Redirect URIs must use HTTPS and have no fragment or credentials');
    }
  }
  return {
    ...config,
    publicBaseUrl: base.origin,
    workspaceDir: resolve(baseDir, config.workspaceDir),
    stateDir: resolve(baseDir, config.stateDir),
  };
}

export async function loadConfig(path: string): Promise<Config> {
  const absolute = resolve(path);
  return parseConfig(JSON.parse(await readFile(absolute, 'utf8')), dirname(absolute));
}

export function assertOrdinaryUser(uid = process.getuid?.()): void {
  if (uid === undefined || uid === 0) throw new Error('Run as a dedicated non-root Linux user');
}

export async function checkWorkspace(config: Config): Promise<void> {
  await access(config.workspaceDir, constants.R_OK | constants.W_OK | constants.X_OK);
  const { stat } = await import('node:fs/promises');
  if (!(await stat(config.workspaceDir)).isDirectory()) throw new Error('workspaceDir must be a directory');
}
