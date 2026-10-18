import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 90_000;
export const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_COMMANDS = 2;
const KILL_GRACE_MS = 1000;
const DRAIN_MS = 250;

export type ExecutionResult = {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; truncated: boolean; outputIncomplete: boolean;
  durationMs: number; cleanupErrors: string[]; error?: string;
};

export function executionEnvironment(): NodeJS.ProcessEnv {
  const account = userInfo();
  return {
    HOME: account.homedir, USER: account.username, LOGNAME: account.username,
    SHELL: '/bin/bash', LANG: 'C.UTF-8', TMPDIR: '/tmp', TERM: 'dumb',
    PATH: [join(account.homedir, '.local/bin'), dirname(process.execPath),
      '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':'),
  };
}

/** Shared by every request of one running service; never created per MCP call. */
export class Executor {
  private running = 0;
  constructor(readonly workspace: string) {}

  async execute(command: string, timeout = DEFAULT_TIMEOUT_MS, includeStderr = true): Promise<ExecutionResult> {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
      throw new Error(`timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
    }
    if (this.running >= MAX_COMMANDS) throw new Error('busy: both command slots are occupied; retry after an existing command finishes');
    this.running++;
    try { return await this.run(command, timeout, includeStderr); }
    finally { this.running--; }
  }

  private run(command: string, timeout: number, includeStderr: boolean): Promise<ExecutionResult> {
    const started = Date.now();
    return new Promise(resolve => {
      const output: Buffer[] = [], errors: Buffer[] = [], cleanupErrors: string[] = [];
      let size = 0, truncated = false, timedOut = false, finished = false;
      let exited = false, closed = false, forceSent = false, outputIncomplete = false;
      let exitCode: number | null = null, signal: string | null = null, error: string | undefined;
      let drainTimer: NodeJS.Timeout | undefined, forceTimer: NodeJS.Timeout | undefined;
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: this.workspace, env: executionEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const capture = (chunks: Buffer[], chunk: Buffer, enabled: boolean) => {
        if (!enabled) return; // The data listener still drains discarded stderr.
        const keep = Math.min(chunk.length, MAX_OUTPUT_BYTES - size);
        if (keep > 0) { chunks.push(Buffer.from(chunk.subarray(0, keep))); size += keep; }
        if (keep < chunk.length) truncated = true;
      };
      child.stdout.on('data', (chunk: Buffer) => capture(output, chunk, true));
      child.stderr.on('data', (chunk: Buffer) => capture(errors, chunk, includeStderr));

      const groupExists = (): boolean => {
        if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; }
        catch (failure) { return (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
      };
      const send = (value: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, value); }
        catch (failure) {
          const code = (failure as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') cleanupErrors.push(`${value}: ${code ?? 'signal delivery failed'}`);
        }
      };
      const text = (chunks: Buffer[]): string => {
        // write(), without end(), omits an incomplete final UTF-8 sequence at a byte limit.
        return new StringDecoder('utf8').write(Buffer.concat(chunks));
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline); clearTimeout(forceTimer); clearTimeout(drainTimer);
        outputIncomplete = outputIncomplete || !closed;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        resolve({ stdout: text(output), stderr: text(errors), exitCode, signal, timedOut, truncated,
          outputIncomplete, durationMs: Date.now() - started, cleanupErrors, ...(error ? { error } : {}) });
      };
      const deadline = setTimeout(() => {
        timedOut = true;
        send('SIGTERM');
        forceTimer = setTimeout(() => {
          forceSent = true;
          if (groupExists()) send('SIGKILL');
          if (closed) finish();
          else drainTimer = setTimeout(finish, DRAIN_MS);
        }, KILL_GRACE_MS);
      }, timeout);

      child.once('error', failure => {
        error = `Unable to start command: ${(failure as NodeJS.ErrnoException).code ?? failure.message}`;
        finish();
      });
      child.once('exit', (code, value) => {
        exited = true; exitCode = code; signal = value;
        if (!timedOut) { clearTimeout(deadline); drainTimer = setTimeout(finish, DRAIN_MS); }
      });
      child.once('close', () => {
        closed = true;
        if (exited && (!timedOut || forceSent || !groupExists())) finish();
      });
    });
  }
}
