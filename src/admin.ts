import { hash } from '@node-rs/argon2';
import { createInterface } from 'node:readline';
import { loadConfig, assertOrdinaryUser } from './config.js';
import { Store } from './store.js';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Password setup requires an interactive terminal');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      process.stdin.off('data', input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const input = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { done(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { done(); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ' && Buffer.byteLength(value + char) <= 1024) value += char;
      }
    };
    process.stdin.on('data', input);
  });
}

async function confirm(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Confirmation requires an interactive terminal');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question('Revoke every connection? Type REVOKE: ', resolve));
  rl.close();
  if (answer !== 'REVOKE') throw new Error('Cancelled');
}

async function main(): Promise<void> {
  assertOrdinaryUser();
  const [command, path] = process.argv.slice(2);
  if (!path || !['password', 'revoke-all'].includes(command ?? '') || process.argv.length !== 4) {
    throw new Error('Usage: node dist/admin.js <password|revoke-all> <config.json>');
  }
  const config = await loadConfig(path);
  const store = new Store(config.stateDir);
  try {
    if (command === 'revoke-all') { await confirm(); store.revokeAll(); console.log('All authorizations revoked.'); return; }
    const password = await readPassword('New strong password (at least 20 characters): ');
    if ([...password].length < 20) throw new Error('Use at least 20 characters, preferably generated randomly');
    if (password !== await readPassword('Confirm password: ')) throw new Error('Passwords do not match');
    store.setPassword(await hash(password));
    console.log('Password saved; existing authorizations revoked.');
  } finally { store.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Administration failed');
  process.exitCode = 1;
});
