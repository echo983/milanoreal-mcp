import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Filesystem, MAX_FILE_BYTES } from '../src/filesystem.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'milano-files-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new Filesystem(path);
}

test('Unicode text, paths, overwrites and directory reads use filesystem semantics', async t => {
  const files = await fixture(t);
  const name = 'sub/你好 world.txt';
  await files.write(name, '你好');
  const absolute = join(files.workspace, name), uri = pathToFileURL(absolute).href;
  assert.equal((await files.read(uri) as { text: string }).text, '你好');
  await files.write(absolute, 'short');
  assert.equal(await readFile(absolute, 'utf8'), 'short');
  assert.equal((await stat(absolute)).mode & 0o777, 0o600);
  await files.write('.hidden', 'h');
  assert.deepEqual((await files.list()).entries.map(e => e.name), ['.hidden', 'sub']);
  const directory = await files.read('sub');
  assert('text' in directory);
  assert.equal(JSON.parse(directory.text).entries[0].uri, uri);
  assert.equal(files.path('~'), userInfo().homedir);
  assert.equal(files.path('../outside'), join(files.workspace, '../outside'));
  for (const bad of ['', 'a\0b', 'file://remote/path', 'file:///tmp/a?b', 'file:///tmp/a%00b']) assert.throws(() => files.path(bad));
});

test('binary resources and file limits preserve existing content on oversized writes', async t => {
  const files = await fixture(t);
  const bytes = Buffer.from([0, 255, 1, 254]);
  await writeFile(join(files.workspace, 'binary'), bytes);
  const resource = await files.read('binary');
  assert('blob' in resource);
  assert.deepEqual(Buffer.from(resource.blob, 'base64'), bytes);
  await files.write('keep', 'original');
  await assert.rejects(files.write('keep', '中'.repeat(MAX_FILE_BYTES)), /1 MiB/);
  assert.equal((await files.read('keep') as { text: string }).text, 'original');
  await writeFile(join(files.workspace, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await assert.rejects(files.read('large'), /1 MiB/);
});

test('symlink deletion removes only links; recursive deletion and missing errors are explicit', async t => {
  const files = await fixture(t);
  await files.write('dir/target', 'keep');
  await symlink(join(files.workspace, 'dir'), join(files.workspace, 'link'));
  assert.equal((await files.list()).entries.find(e => e.name === 'link')?.type, 'symlink');
  await files.delete('link');
  assert.equal(await readFile(join(files.workspace, 'dir/target'), 'utf8'), 'keep');
  await files.delete('dir');
  await assert.rejects(files.read('dir/target'), /ENOENT/);
  await assert.rejects(files.delete('dir'), /ENOENT/);
});

test('file APIs reject FIFOs, devices and Linux permission failures without blocking', async t => {
  const files = await fixture(t);
  await promisify(execFile)('mkfifo', [join(files.workspace, 'pipe')]);
  await assert.rejects(files.read('pipe'), /regular/);
  await assert.rejects(files.write('pipe', 'data'), /ENXIO|regular/);
  await assert.rejects(files.read('/dev/zero'), /regular/);
  await files.write('private', 'secret');
  await chmod(join(files.workspace, 'private'), 0);
  try { await assert.rejects(files.read('private'), /EACCES/); }
  finally { await chmod(join(files.workspace, 'private'), 0o600); }
});

test('large directory listing is bounded and marked truncated', async t => {
  const files = await fixture(t);
  for (let start = 0; start < 1002; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 1002 - start) }, (_, i) => writeFile(join(files.workspace, String(start + i)), '')));
  }
  const listing = await files.list();
  assert.equal(listing.entries.length, 1000);
  assert.equal(listing.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(listing)) <= 256 * 1024);
});
