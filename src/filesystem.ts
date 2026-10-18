import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_LIST_BYTES = 256 * 1024;

type Entry = { name: string; type: 'file' | 'directory' | 'symlink' | 'other'; uri: string };
export type Listing = { path: string; uri: string; entries: Entry[]; truncated: boolean };
export type FileContent = { uri: string; mimeType: string } & ({ text: string } | { blob: string });
const mimeTypes: Record<string, string> = {
  '.json': 'application/json', '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/plain',
  '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv',
  '.html': 'text/html', '.css': 'text/css', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

export class Filesystem {
  constructor(readonly workspace: string) {}

  path(input: string): string {
    if (!input || input.includes('\0')) throw new Error('path must be nonempty and contain no NUL');
    if (input.startsWith('file:')) {
      const uri = new URL(input);
      if (uri.hostname || uri.search || uri.hash) throw new Error('Only local file URIs without query or fragment are supported');
      input = fileURLToPath(uri);
      if (input.includes('\0')) throw new Error('path must contain no NUL');
    }
    if (input === '~') input = userInfo().homedir;
    else if (input.startsWith('~/')) input = join(userInfo().homedir, input.slice(2));
    return resolve(this.workspace, input);
  }

  async list(input = '.'): Promise<Listing> {
    const path = this.path(input), uri = pathToFileURL(path).href;
    const entries: Entry[] = [];
    let truncated = false;
    let size = Buffer.byteLength(JSON.stringify({ path, uri, entries, truncated }));
    for await (const entry of await opendir(path)) {
      const item: Entry = { name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        uri: pathToFileURL(join(path, entry.name)).href };
      const added = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (entries.length >= MAX_ENTRIES || size + added > MAX_LIST_BYTES) { truncated = true; break; }
      size += added; entries.push(item);
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { path, uri, entries, truncated };
  }

  async read(input: string): Promise<FileContent> {
    const path = this.path(input);
    const info = await stat(path);
    if (info.isDirectory()) return { uri: pathToFileURL(path).href, mimeType: 'application/json', text: JSON.stringify(await this.list(input)) };
    if (!info.isFile()) throw new Error('Only regular files and directories can be read');
    // O_NONBLOCK also prevents a path replaced with a FIFO from blocking open().
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile()) throw new Error('Only regular files can be read');
      if (current.size > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB; use container_exec to inspect or process a bounded section');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB; use container_exec to process a bounded section');
      const bytes = buffer.subarray(0, size);
      const mimeType = mimeTypes[extname(path).toLowerCase()];
      const binary = mimeType && !mimeType.startsWith('text/') && !['application/json', 'application/xml', 'image/svg+xml'].includes(mimeType);
      if (!binary && !bytes.includes(0)) {
        try { return { uri: pathToFileURL(path).href, mimeType: mimeType ?? 'text/plain', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
        catch { /* Binary bytes below are returned as an embedded resource. */ }
      }
      return { uri: pathToFileURL(path).href, mimeType: mimeType ?? 'application/octet-stream', blob: bytes.toString('base64') };
    } finally { await handle.close(); }
  }

  async write(input: string, text: string): Promise<{ path: string; bytesWritten: number }> {
    const path = this.path(input), bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Content exceeds the 1 MiB write limit');
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Only regular files can be written');
      await handle.truncate(0);
      await handle.writeFile(bytes);
    } finally { await handle.close(); }
    return { path, bytesWritten: bytes.length };
  }

  async delete(input: string): Promise<{ path: string; deleted: true }> {
    const path = this.path(input);
    await lstat(path); // Report a missing target rather than claiming a successful deletion.
    await rm(path, { recursive: true, force: false });
    return { path, deleted: true };
  }
}
