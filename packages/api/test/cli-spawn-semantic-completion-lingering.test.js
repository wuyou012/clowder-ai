/**
 * Red test: semantic completion must finalize spawnCli even when the CLI process
 * keeps stdout OPEN after its terminal `result` event (process lingers).
 *
 * Root cause (false 9-min timeout): the NDJSON loop only breaks on stdout EOF /
 * probe-dead / stall-kill. The terminal `result` event is yielded but does NOT
 * break the loop, so when the process stays alive (e.g. --chrome / MCP stdio keep
 * the event loop alive) stdout never EOFs and the loop spins until the silence
 * timeout fires (~9 min) → spurious __cliTimeout even though the turn SUCCEEDED.
 *
 * Fix contract: when options.semanticCompletionSignal aborts, the loop breaks and
 * the existing post-loop grace (SEMANTIC_COMPLETION_GRACE_MS) + finally killChild
 * finalize — NO __cliTimeout is yielded, and the lingering process is killed.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { spawnCli, isCliTimeout } = await import('../dist/utils/cli-spawn.js');

function createMockProcess(opts = {}) {
  const { exitOnKill = true, exitCode = 0, pid = 12345, autoCloseOnExit = true } = opts;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit' && autoCloseOnExit) {
      setImmediate(() => originalEmit('close', exitCode, null));
    }
    return emitted;
  };
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid,
    killed: false,
    kill(signal) {
      if (this.killed) return false;
      this.killed = true;
      if (exitOnKill) {
        stdout.end();
        setImmediate(() => emitter.emit('exit', exitCode, signal || 'SIGTERM'));
      }
      return true;
    },
    ref() {},
    unref() {},
  });
}

test('semantic completion finalizes without __cliTimeout when stdout stays open after result', async () => {
  const mock = createMockProcess();
  const semantic = new AbortController();
  const spawnFn = () => mock;

  // Emit terminal result/success then KEEP stdout open (process lingers — never EOFs).
  setImmediate(() => {
    mock.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
  });

  const events = [];
  const gen = spawnCli(
    {
      command: 'claude',
      args: [],
      // timeoutMs (8s) > SEMANTIC_COMPLETION_GRACE_MS (5s): with no probe the loop
      // blocks in `ndjson.next()` after the result event, so without semantic-in-race
      // it spins until this fires → __cliTimeout (red). The fix must break the loop on
      // the semantic abort even while blocked awaiting the next event.
      timeoutMs: 8000,
      semanticCompletionSignal: semantic.signal,
    },
    { spawnFn },
  );

  for await (const ev of gen) {
    events.push(ev);
    // Provider contract: abort the semantic signal on terminal result/success.
    const raw = ev && typeof ev === 'object' ? ev : {};
    if (raw.type === 'result' && raw.subtype === 'success') {
      semantic.abort();
    }
  }

  const sawResult = events.some((e) => e && typeof e === 'object' && e.type === 'result' && e.subtype === 'success');
  assert.ok(sawResult, 'terminal result event must still be yielded (not truncated)');

  const timeouts = events.filter((e) => isCliTimeout(e));
  assert.equal(timeouts.length, 0, 'must NOT yield __cliTimeout — result is the semantic completion point');

  assert.ok(mock.killed, 'lingering process must be killed by the post-completion grace');
});
