import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import test from 'node:test';
import {
  extractAgyConversationId,
  extractAgyPlannerResponse,
  invokeAgyPty,
  isAgyReadyPrompt,
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
