import { userInfo } from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Executor, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './execution.js';
import { Filesystem, MAX_FILE_BYTES } from './filesystem.js';

const filePath = z.object({ path: z.string().min(1).describe('Absolute VPS path, local file URI, or path relative to the fixed workspace') }).strict();
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const json = (value: object, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: { ...value }, isError,
});

async function report(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await operation(); }
  catch (failure) {
    return json({ error: failure instanceof Error ? failure.message : 'Tool operation failed' }, true);
  }
}

export function instructions(workspace: string): string {
  return `You operate a real Linux VPS as user ${userInfo().username} (uid ${process.getuid?.()}).
The fixed working directory is ${JSON.stringify(workspace)}. Files, projects and installed dependencies persist across conversations and service restarts. No initialization tool is needed.
Each container_exec call starts a new non-interactive /bin/bash process. Shell variables, cd and Python memory do not persist between calls. Specify cd, venv paths and environment assignments in each command when needed.
The tool names retain the container_ prefix for compatibility; execution is directly on the VPS, under the service user's Linux permissions. File tools do not use sudo. Use sudo -n explicitly only if the administrator has configured passwordless sudo.
Default command timeout is ${DEFAULT_TIMEOUT_MS}ms, maximum ${MAX_TIMEOUT_MS}ms; output is bounded to ${MAX_OUTPUT_BYTES} bytes. At most two foreground commands run at once; busy means retry after one finishes. A stopped chat or timeout does not prove every privileged or detached child has stopped. Do not automatically repeat side-effecting commands after an unknown network result.
For long tasks, explicitly detach with setsid, disconnect stdin and redirect stdout/stderr to logs. Record a verifiable task identity and log path. nohup or & alone is not enough. Service restarts clean up processes in its systemd cgroup.
At the start of an existing project, read its instructions and PROGRESS.md if present. At milestones and handoffs record completed work, relevant paths, logs, running tasks, next steps and a timestamp in that project's PROGRESS.md. Verify actual files and processes when resuming; old PIDs may have been reused. Never write passwords or tokens into progress notes.
File reads/writes are bounded to ${MAX_FILE_BYTES} bytes. For larger files or large command output, use bounded shell tools or scripts. Do not assume Python or other tools are installed; check the environment. The Node runtime is ${process.version}.`;
}

export function registerTools(server: McpServer, executor: Executor, files: Filesystem): void {
  server.registerTool('container_ping', {
    description: 'Check the VPS command environment and report the actual user and fixed workspace. No initialization is required.',
    annotations: readonly,
  }, () => report(async () => {
    const result = await executor.execute('true', 5000);
    if (result.error || result.timedOut || result.exitCode !== 0) return json(result, true);
    return json({ ok: true, user: userInfo().username, uid: process.getuid?.(), workspace: executor.workspace,
      shell: '/bin/bash', nodeVersion: process.version });
  }));

  server.registerTool('container_exec', {
    description: 'Run an independent non-interactive shell command directly on the persistent VPS. timeout is milliseconds (default 60000, max 90000). streamStderr controls stderr inclusion in the final result, not real-time streaming.',
    inputSchema: { args: z.object({ args: z.string(), timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(), streamStderr: z.boolean().default(true) }).strict() },
    annotations: { ...write, openWorldHint: true },
  }, ({ args }) => report(async () => {
    const result = await executor.execute(args.args, args.timeout, args.streamStderr);
    return json(result, !!result.error || result.timedOut || result.exitCode !== 0);
  }));

  server.registerTool('container_file_write', {
    description: 'Write full UTF-8 file content on the VPS, overwriting existing content and creating parent directories. Maximum 1 MiB; ordinary user permissions apply.',
    inputSchema: { args: filePath.extend({ text: z.string().max(MAX_FILE_BYTES) }) }, annotations: write,
  }, ({ args }) => report(async () => json(await files.write(args.path, args.text))));

  server.registerTool('container_files_list', {
    description: 'List the first level of the fixed workspace, including hidden files. Entries have names, types and local resource URIs; large listings are marked truncated.',
    annotations: readonly,
  }, () => report(async () => json(await files.list())));

  server.registerTool('container_file_read', {
    description: 'Read a VPS regular file (up to 1 MiB), or list one directory level. Returns text or a MIME-typed base64 embedded resource. File URIs identify VPS paths, not public download links.',
    inputSchema: { args: filePath }, annotations: readonly,
  }, ({ args }) => report(async () => ({ content: [{ type: 'resource', resource: await files.read(args.path) }] })));

  server.registerTool('container_file_delete', {
    description: 'Delete a file or recursively delete a directory on the VPS under ordinary user permissions. Deleting a symlink removes the link; a missing target is reported as an error.',
    inputSchema: { args: filePath }, annotations: write,
  }, ({ args }) => report(async () => json(await files.delete(args.path))));
}
