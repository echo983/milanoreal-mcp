import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor, MAX_OUTPUT_BYTES } from '../src/execution.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'milano-exec-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new Executor(path);
}

test('commands use independent shells, scrubbed environment, EOF stdin and real exit status', async t => {
  const executor = await fixture(t);
  process.env.MILANO_TEST_SECRET = 'must-not-inherit';
  try {
    await executor.execute('export MILANO_EXPORTED=old; cd /');
    const result = await executor.execute('printf "%s|%s|%s" "$PWD" "${MILANO_EXPORTED-unset}" "${MILANO_TEST_SECRET-unset}"; cat; printf error >&2; exit 7');
    assert.equal(result.stdout, `${executor.workspace}|unset|unset`);
    assert.equal(result.stderr, 'error');
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
    assert.equal((await executor.execute('node -p "1+1"')).stdout.trim(), '2');
  } finally { delete process.env.MILANO_TEST_SECRET; }
});

test('large output is drained, byte bounded and does not split final UTF-8', async t => {
  const executor = await fixture(t);
  const result = await executor.execute(`node -e 'process.stdout.write("中".repeat(400000)); process.stderr.write("e".repeat(400000))'`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert(Buffer.byteLength(result.stdout + result.stderr) <= MAX_OUTPUT_BYTES);
  assert(!result.stdout.includes('\ufffd'));
  const discarded = await executor.execute(`node -e 'process.stderr.write("e".repeat(400000));process.stdout.write("ok")'`, 5000, false);
  assert.equal(discarded.stdout, 'ok');
  assert.equal(discarded.stderr, '');
  assert.equal(discarded.truncated, false);
});

test('two slots are shared, busy rejects immediately and completed slots are reusable', async t => {
  const executor = await fixture(t);
  const first = executor.execute('sleep .3'), second = executor.execute('sleep .3');
  await assert.rejects(executor.execute('true'), /busy/);
  await Promise.all([first, second]);
  assert.equal((await executor.execute('true')).exitCode, 0);
  await assert.rejects(executor.execute('true', 90001), /timeout/);
});

test('normal shell exit bounds inherited-pipe draining without a false timeout', async t => {
  const executor = await fixture(t);
  const result = await executor.execute('sleep .8 & printf done', 150);
  assert.equal(result.stdout, 'done');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputIncomplete, true);
  assert(result.durationMs < 750);
});

test('timeout kills owned TERM-resistant shell descendants after grace', async t => {
  const executor = await fixture(t);
  const result = await executor.execute(String.raw`node -e 'process.on("SIGTERM",()=>{}); const child=require("child_process").spawn(process.execPath,["-e","process.on(\"SIGTERM\",()=>{});setTimeout(()=>process.exit(),5000)"],{stdio:"ignore"}); require("fs").writeFileSync("pid",process.pid+" "+child.pid); setTimeout(()=>process.exit(),5000)'`, 500);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, '');
  assert(result.durationMs < 3000);
  const pids = (await readFile(join(executor.workspace, 'pid'), 'utf8')).trim().split(' ');
  for (const pid of pids) {
    try {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.match(state, /\) [ZX] /);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  assert.equal((await executor.execute('true')).exitCode, 0);
});

test('spawn failure reports an error and releases its execution slot', async () => {
  const executor = new Executor('/nonexistent-milanoreal-test-workspace');
  for (let i = 0; i < 3; i++) assert.match((await executor.execute('true')).error!, /ENOENT/);
});

test('explicitly detached task can finish after the foreground command returns', async t => {
  const executor = await fixture(t);
  const result = await executor.execute(`setsid bash -c 'sleep .2; printf completed > marker' </dev/null >task.log 2>&1 &`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputIncomplete, false);
  assert.equal((await executor.execute('sleep .4; cat marker')).stdout, 'completed');
});
