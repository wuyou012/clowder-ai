import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import test from 'node:test';
import {
  extractAgyConversationId,
  extractAgyPlannerResponse,
  invokeAgyPty,
  isAgyCliLogReady,
  isAgyReadyPrompt,
  isAgyTrustDialog,
  stripAgyAnsi,
} from '../dist/domains/cats/services/agents/providers/agy-pty-adapter.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('agy');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function createAgyTempPaths() {
  const root = mkdtempSync(join(tmpdir(), 'agy-pty-test-'));
  return {
    root,
    cliLogPath: join(root, 'cli.log'),
    brainRoot: join(root, 'brain'),
  };
}

function createFakePtySpawn({ readyData, onWrite } = {}) {
  const dataHandlers = new Set();
  const exitHandlers = new Set();
  const term = {
    write: mock.fn((data) => {
      onWrite?.(data, term);
    }),
    kill: mock.fn(),
    onData(handler) {
      dataHandlers.add(handler);
      return {
        dispose() {
          dataHandlers.delete(handler);
        },
      };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return {
        dispose() {
          exitHandlers.delete(handler);
        },
      };
    },
    emitData(data) {
      for (const handler of dataHandlers) handler(data);
    },
    emitExit(event) {
      for (const handler of exitHandlers) handler(event);
    },
  };

  const spawn = mock.fn(() => {
    if (readyData !== undefined) {
      process.nextTick(() => term.emitData(readyData));
    }
    return term;
  });

  return { spawn, term };
}

function writePlannerTranscript(brainRoot, conversationId, content) {
  const transcriptDir = join(brainRoot, conversationId, '.system_generated', 'logs');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, 'transcript_full.jsonl'),
    `${JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content,
    })}\n`,
  );
}

test('agy pty helpers strip ANSI terminal control sequences', () => {
  assert.equal(stripAgyAnsi('\u001b[32m>\u001b[0m\r'), '>');
  assert.equal(isAgyReadyPrompt('\u001b[?25h\n> '), true);
});

test('agy pty helpers detect cli.log ready signal', () => {
  assert.equal(isAgyCliLogReady('CLI ready for user input (startup took 4.6724ms)'), false);
  assert.equal(
    isAgyCliLogReady(
      [
        'CLI ready for user input (startup took 4.6724ms)',
        'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
      ].join('\n'),
    ),
    true,
  );
  assert.equal(isAgyCliLogReady('Starting CLI program'), false);
});

test('agy pty helpers read the latest conversation id from cli.log text', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';

  assert.equal(
    extractAgyConversationId(
      [
        `2026-06-04T00:00:00Z Created conversation ${first}`,
        'noise',
        `2026-06-04T00:00:01Z Streaming conversation ${second}`,
      ].join('\n'),
    ),
    second,
  );
});

test('agy pty helpers extract the latest completed model planner response', () => {
  const transcript = [
    '{"source":"MODEL","type":"PLANNER_RESPONSE","status":"RUNNING","content":"partial"}',
    '{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"first"}',
    '{"source":"TOOL","type":"PLANNER_RESPONSE","status":"DONE","content":"ignored"}',
    'not-json-yet',
    '{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"final answer"}',
  ].join('\n');

  assert.equal(extractAgyPlannerResponse(transcript), 'final answer');
});

test('invokeAgyPty yields error and done when PTY never becomes ready', async () => {
  const paths = createAgyTempPaths();
  const fakePty = createFakePtySpawn();

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 20,
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(fakePty.spawn.mock.callCount(), 1);
  assert.equal(msgs[0]?.type, 'error');
  assert.match(msgs[0]?.error ?? '', /PTY/);
  assert.equal(msgs.at(-1)?.type, 'done');
  assert.equal(fakePty.term.kill.mock.callCount(), 1);
});

test('invokeAgyPty proceeds when cli.log reports ready without PTY prompt', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '77777777-7777-4777-8777-777777777777';
  const fakePty = createFakePtySpawn({
    onWrite(data) {
      if (data.startsWith('\x1b[200~')) {
        writeFileSync(
          paths.cliLogPath,
          [
            'CLI ready for user input (startup took 4.6724ms)',
            'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
            `2026-06-04T00:00:00Z Streaming conversation ${conversationId}`,
          ].join('\n'),
        );
        writePlannerTranscript(paths.brainRoot, conversationId, 'ready from cli log');
      }
    },
  });

  setTimeout(() => {
    writeFileSync(
      paths.cliLogPath,
      [
        'CLI ready for user input (startup took 4.6724ms)',
        'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
      ].join('\n'),
    );
  }, 5);

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 100,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'session_init');
  assert.equal(msgs[0]?.sessionId, conversationId);
  assert.equal(msgs[1]?.type, 'text');
  assert.equal(msgs[1]?.content, 'ready from cli log');
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty handles cli.log truncation before ready signal', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '88888888-8888-4888-8888-888888888888';
  writeFileSync(paths.cliLogPath, 'old log line\n'.repeat(200));

  const fakePty = createFakePtySpawn({
    onWrite(data) {
      if (data.startsWith('\x1b[200~')) {
        writeFileSync(
          paths.cliLogPath,
          [
            'CLI ready for user input (startup took 4.6724ms)',
            'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
            `2026-06-04T00:00:00Z Streaming conversation ${conversationId}`,
          ].join('\n'),
        );
        writePlannerTranscript(paths.brainRoot, conversationId, 'ready after log truncation');
      }
    },
  });

  setTimeout(() => {
    writeFileSync(
      paths.cliLogPath,
      [
        'CLI ready for user input (startup took 4.6724ms)',
        'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
      ].join('\n'),
    );
  }, 5);

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 100,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'session_init');
  assert.equal(msgs[0]?.sessionId, conversationId);
  assert.equal(msgs[1]?.type, 'text');
  assert.equal(msgs[1]?.content, 'ready after log truncation');
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty classifies cli.log diagnostics when ready times out', async () => {
  const paths = createAgyTempPaths();
  const fakePty = createFakePtySpawn();

  setTimeout(() => {
    writeFileSync(
      paths.cliLogPath,
      [
        'Authentication required. Please visit the URL to log in:',
        'https://accounts.google.com/o/oauth2/auth?client_id=test',
        'Waiting for authentication (timeout 60s)...',
        'Error: authentication interrupted.',
      ].join('\n'),
    );
  }, 5);

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 30,
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'error');
  assert.match(msgs[0]?.error ?? '', /not authenticated/i);
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty yields error and done when cli.log has no conversation id', async () => {
  const paths = createAgyTempPaths();
  const fakePty = createFakePtySpawn({ readyData: '\n> ' });

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'error');
  assert.match(msgs[0]?.error ?? '', /conversation id/i);
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty classifies cli.log diagnostics when transcript times out', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '33333333-3333-4333-8333-333333333333';
  const fakePty = createFakePtySpawn({
    readyData: '\n> ',
    onWrite() {
      writeFileSync(
        paths.cliLogPath,
        [
          `2026-06-04T00:00:00Z Created conversation ${conversationId}`,
          'Authentication required. Please visit the URL to log in:',
          'https://accounts.google.com/o/oauth2/auth?client_id=test',
          'Waiting for authentication (timeout 60s)...',
          'Error: authentication interrupted.',
        ].join('\n'),
      );
    },
  });

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'session_init');
  const error = msgs.find((msg) => msg.type === 'error');
  assert.ok(error);
  assert.match(error.error, /not authenticated/i);
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty surfaces cli.log diagnostics while waiting for transcript', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '99999999-9999-4999-8999-999999999999';
  const fakePty = createFakePtySpawn({
    readyData: '\n> ',
    onWrite() {
      writeFileSync(paths.cliLogPath, `2026-06-04T00:00:00Z Created conversation ${conversationId}\n`);
      setTimeout(() => {
        appendFileSync(
          paths.cliLogPath,
          [
            '',
            'agent executor error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
            'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
          ].join('\n'),
        );
      }, 5);
    },
  });

  const startedAt = Date.now();
  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    }),
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(msgs[0]?.type, 'session_init');
  const error = msgs.find((msg) => msg.type === 'error');
  assert.ok(error);
  assert.match(error.error, /location|地区|区域|not support/i);
  assert.ok(elapsedMs < 700, `expected early diagnostic, got ${elapsedMs}ms`);
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty yields generic error when transcript times out without cli.log diagnostics', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '55555555-5555-4555-8555-555555555555';
  const fakePty = createFakePtySpawn({
    readyData: '\n> ',
    onWrite() {
      writeFileSync(paths.cliLogPath, `2026-06-04T00:00:00Z Created conversation ${conversationId}\n`);
    },
  });

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 20,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'session_init');
  const error = msgs.find((msg) => msg.type === 'error');
  assert.ok(error);
  assert.match(error.error, /transcript/i);
  assert.equal(msgs.at(-1)?.type, 'done');
});

test('invokeAgyPty yields session_init, text, and done from transcript planner response', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const fakePty = createFakePtySpawn({
    readyData: '\n> ',
    onWrite() {
      writeFileSync(paths.cliLogPath, `2026-06-04T00:00:00Z Streaming conversation ${conversationId}\n`);
      writePlannerTranscript(paths.brainRoot, conversationId, 'hello');
    },
  });

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 1_000,
      timeoutMs: 100,
      pollIntervalMs: 5,
    }),
  );

  assert.equal(msgs[0]?.type, 'session_init');
  assert.equal(msgs[0]?.sessionId, conversationId);
  assert.equal(msgs[1]?.type, 'text');
  assert.equal(msgs[1]?.content, 'hello');
  assert.equal(msgs[2]?.type, 'done');
});

test('isAgyTrustDialog detects workspace trust dialog and ignores normal output', () => {
  assert.equal(
    isAgyTrustDialog('Do you trust the contents of this project?\n> Yes, I trust this folder\nNo, exit\n'),
    true,
  );
  // ANSI-wrapped version
  assert.equal(
    isAgyTrustDialog('[1mDo you trust the contents of this project?[0m\n> Yes, I trust this folder\n'),
    true,
  );
  // Normal ready prompt — must NOT trigger
  assert.equal(isAgyTrustDialog('\n> '), false);
  assert.equal(isAgyTrustDialog('hello world\n> '), false);
});

test('invokeAgyPty auto-confirms workspace trust dialog and proceeds to ready', async () => {
  const paths = createAgyTempPaths();
  const conversationId = '66666666-6666-4666-8666-666666666666';
  let enterReceived = false;

  const TRUST_DIALOG =
    'Do you trust the contents of this project?\n> Yes, I trust this folder\nNo, exit\n\n↑/↓ Navigate · enter Confirm';

  const fakePty = createFakePtySpawn({
    readyData: TRUST_DIALOG,
    onWrite(data, term) {
      if (!enterReceived && data === '\r') {
        // Trust confirmation Enter received — emit ready prompt
        enterReceived = true;
        setTimeout(() => term.emitData('\n> '), 5);
      } else if (data.startsWith('\x1b[200~')) {
        // Actual prompt submission — write cli.log + transcript
        setTimeout(() => {
          writeFileSync(
            paths.cliLogPath,
            `2026-06-04T00:00:00Z Streaming conversation ${conversationId}\n`,
          );
          writePlannerTranscript(paths.brainRoot, conversationId, 'trusted workspace response');
        }, 5);
      }
    },
  });

  const msgs = await collect(
    invokeAgyPty('who are you', 'gemini', {
      ...paths,
      ptySpawn: fakePty.spawn,
      readyTimeoutMs: 2_000,
      timeoutMs: 500,
      pollIntervalMs: 5,
    }),
  );

  assert.ok(enterReceived, 'should have sent Enter to auto-confirm trust dialog');
  assert.equal(msgs[0]?.type, 'session_init');
  assert.equal(msgs[0]?.sessionId, conversationId);
  assert.equal(msgs[1]?.type, 'text');
  assert.equal(msgs[1]?.content, 'trusted workspace response');
  assert.equal(msgs.at(-1)?.type, 'done');
});
