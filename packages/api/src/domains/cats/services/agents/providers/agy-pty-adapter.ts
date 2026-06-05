import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../utils/cli-spawn.js';
import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { classifyAntigravityCliPlainText } from './antigravity-cli-event-parser.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';

const log = createModuleLogger('agy-pty-adapter');

const AGY_HOME = join(homedir(), '.gemini', 'antigravity-cli');
const DEFAULT_CLI_LOG_PATH = join(AGY_HOME, 'cli.log');
const DEFAULT_BRAIN_ROOT = join(AGY_HOME, 'brain');
const READY_TIMEOUT_MS = 30_000;
const READY_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 200;

interface AgyTranscriptEntry {
  readonly source?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly content?: unknown;
}

interface AgyPtyRuntimeOptions {
  readonly cliLogPath?: string;
  readonly brainRoot?: string;
  readonly timeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly ptySpawn?: typeof pty.spawn;
}

export function stripAgyAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

export function isAgyReadyPrompt(value: string): boolean {
  const stripped = stripAgyAnsi(value).trimEnd();
  return stripped === '>' || stripped.endsWith('\n>');
}

/**
 * Detects agy 1.0.5+ workspace trust dialog.
 * When the working directory is not in trustedWorkspaces, agy prompts:
 *   "Do you trust the contents of this project?"
 * This must be auto-confirmed by pressing Enter before the ready prompt appears.
 */
export function isAgyTrustDialog(value: string): boolean {
  return stripAgyAnsi(value).includes('Do you trust the contents of this project');
}

export function isAgyCliLogReady(value: string): boolean {
  return (
    value.includes('CLI ready for user input') &&
    /Propagating selected model override to backend: label=/.test(value)
  );
}

export function extractAgyConversationId(value: string): string | null {
  const matches = [...value.matchAll(/\b(?:Created|Streaming) conversation ([0-9a-f-]{36})\b/gi)];
  return matches.length > 0 ? matches[matches.length - 1]?.[1] ?? null : null;
}

export function extractAgyPlannerResponse(value: string): string | null {
  let latest: string | null = null;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as AgyTranscriptEntry;
      if (
        entry.source === 'MODEL' &&
        entry.type === 'PLANNER_RESPONSE' &&
        entry.status === 'DONE' &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0
      ) {
        latest = entry.content;
      }
    } catch {
      // transcript_full.jsonl may be read while agy is still appending.
    }
  }
  return latest;
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFromOffset(path: string, offset: number): string {
  if (!existsSync(path)) return '';
  const raw = readFileSync(path);
  // AGY can truncate and rewrite cli.log on startup; if the prior offset is
  // past the new file size, read the new log from the beginning.
  if (offset > 0 && offset <= raw.length) {
    return raw.subarray(offset).toString('utf8');
  }
  return raw.toString('utf8');
}

function agyTranscriptPath(conversationId: string, brainRoot: string): string {
  return join(brainRoot, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function waitForReady(
  term: IPty,
  cliLogPath: string,
  initialCliLogOffset: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  let output = '';
  let trustConfirmed = false;
  const disposable = term.onData((data) => {
    output += data;
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      const cliLogText = readFromOffset(cliLogPath, initialCliLogOffset);
      if (isAgyReadyPrompt(output) || isAgyCliLogReady(cliLogText)) {
        await sleep(READY_SETTLE_MS, signal);
        return !signal?.aborted;
      }
      // Auto-confirm workspace trust dialog (agy 1.0.5+).
      // When the working directory is not in trustedWorkspaces, agy shows an
      // interactive prompt that blocks before the '>' ready cursor appears.
      // Pressing Enter selects the highlighted "Yes, I trust this folder" option.
      if (!trustConfirmed && isAgyTrustDialog(output)) {
        log.debug('[agy-pty] workspace trust dialog detected — auto-confirming with Enter');
        trustConfirmed = true;
        term.write('\r');
      }
      await sleep(pollIntervalMs, signal);
    }
    return false;
  } finally {
    disposable.dispose();
  }
}

async function waitForConversationId(
  cliLogPath: string,
  initialOffset: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const conversationId = extractAgyConversationId(readFromOffset(cliLogPath, initialOffset));
    if (conversationId) return conversationId;
    await sleep(pollIntervalMs, signal);
  }
  return null;
}

async function waitForPlannerResponse(
  conversationId: string,
  brainRoot: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string | null> {
  const transcriptPath = agyTranscriptPath(conversationId, brainRoot);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    if (existsSync(transcriptPath)) {
      const content = extractAgyPlannerResponse(readFileSync(transcriptPath, 'utf8'));
      if (content) return content;
    }
    await sleep(pollIntervalMs, signal);
  }
  return null;
}

function applyUserCliArgs(baseArgs: string[], userArgs: readonly string[] | undefined): string[] {
  const userParts: string[] = [];
  for (const arg of userArgs ?? []) {
    userParts.push(...arg.trim().split(/\s+/).filter((part) => part.length > 0));
  }
  if (userParts.length === 0) return baseArgs;

  const accumulativeFlags = new Set(['--add-dir']);
  const userFlags = new Set(userParts.filter((part) => part.startsWith('-')));
  const deduped: string[] = [];
  for (let i = 0; i < baseArgs.length; i++) {
    const part = baseArgs[i];
    if (part.startsWith('-') && userFlags.has(part) && !accumulativeFlags.has(part)) {
      if (i + 1 < baseArgs.length && !baseArgs[i + 1].startsWith('-')) i++;
      continue;
    }
    deduped.push(part);
  }
  return [...deduped, ...userParts];
}

function killPty(term: IPty | null): void {
  if (!term) return;
  try {
    term.kill();
  } catch (err) {
    log.debug({ err }, '[agy-pty] failed to kill pty');
  }
}

function submitPrompt(term: IPty, prompt: string): void {
  const normalizedPrompt = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  term.write(`\x1b[200~${normalizedPrompt}\x1b[201~\r`);
}

export async function* invokeAgyPty(
  prompt: string,
  catId: CatId,
  options?: AgentServiceOptions & AgyPtyRuntimeOptions,
): AsyncIterable<AgentMessage> {
  const metadata: MessageMetadata = {
    provider: 'google',
    model: 'account-selected (agy-pty)',
    modelVerified: false,
    diagnostics: {
      agyPty: {
        modelSelection: 'account-side selected model',
      },
    },
  };
  const timeoutMs = options?.timeoutMs ?? resolveCliTimeoutMs(undefined);
  const readyTimeoutMs = options?.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const cliLogPath = options?.cliLogPath ?? DEFAULT_CLI_LOG_PATH;
  const brainRoot = options?.brainRoot ?? DEFAULT_BRAIN_ROOT;
  const workingDirectory = options?.workingDirectory ?? process.cwd();
  const ptySpawn = options?.ptySpawn ?? pty.spawn;

  const agyCommand = resolveCliCommand('agy');
  if (!agyCommand) {
    yield {
      type: 'error',
      catId,
      error: formatCliNotFoundError('agy'),
      metadata,
      timestamp: Date.now(),
    };
    yield { type: 'done', catId, metadata, timestamp: Date.now() };
    return;
  }

  let effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
  const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
  const imageAccessDirs = collectImageAccessDirectories(imagePaths);
  effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);

  const baseArgs = ['--add-dir', workingDirectory, '--dangerously-skip-permissions'];
  for (const dir of imageAccessDirs) {
    baseArgs.push('--add-dir', dir);
  }
  const args = applyUserCliArgs(baseArgs, options?.cliConfigArgs);
  const childEnv = buildChildEnv({
    ...(options?.callbackEnv ?? {}),
    ...(options?.accountEnv ?? {}),
  }) as Record<string, string>;

  let term: IPty | null = null;
  const initialCliLogOffset = statSize(cliLogPath);
  let ptyExit:
    | {
        readonly exitCode: number;
        readonly signal?: number;
      }
    | undefined;

  try {
    term = ptySpawn(agyCommand, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workingDirectory,
      env: childEnv,
    });
    term.onExit((event) => {
      ptyExit = event;
    });

    const ready = await waitForReady(
      term,
      cliLogPath,
      initialCliLogOffset,
      options?.signal,
      readyTimeoutMs,
      pollIntervalMs,
    );
    if (options?.signal?.aborted) {
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }
    if (!ready) {
      const agyLogText = readFromOffset(cliLogPath, initialCliLogOffset);
      const logClassification = classifyAntigravityCliPlainText({
        stdout: '',
        agyLogText,
      });
      if (logClassification.kind === 'error') {
        yield {
          type: 'error',
          catId,
          error: logClassification.error,
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, metadata, timestamp: Date.now() };
        return;
      }

      yield {
        type: 'error',
        catId,
        error: `Antigravity PTY 未在 ${Math.round(readyTimeoutMs / 1000)}s 内进入可输入状态`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }

    submitPrompt(term, effectivePrompt);
    const conversationId = await waitForConversationId(
      cliLogPath,
      initialCliLogOffset,
      options?.signal,
      Math.min(timeoutMs, 30_000),
      pollIntervalMs,
    );
    if (options?.signal?.aborted) {
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }
    if (!conversationId) {
      yield {
        type: 'error',
        catId,
        error: 'Antigravity PTY 已提交 prompt，但未能从 cli.log 解析 conversation id',
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }

    metadata.sessionId = conversationId;
    yield { type: 'session_init', catId, sessionId: conversationId, metadata, timestamp: Date.now() };

    const response = await waitForPlannerResponse(
      conversationId,
      brainRoot,
      options?.signal,
      timeoutMs,
      pollIntervalMs,
    );
    if (options?.signal?.aborted) {
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }
    if (!response) {
      const agyLogText = readFromOffset(cliLogPath, initialCliLogOffset);
      const logClassification = classifyAntigravityCliPlainText({
        stdout: '',
        agyLogText,
      });
      if (logClassification.kind === 'error') {
        yield {
          type: 'error',
          catId,
          error: logClassification.error,
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, metadata, timestamp: Date.now() };
        return;
      }

      const exitHint =
        ptyExit && ptyExit.exitCode !== 0
          ? `；PTY 已退出 (code: ${ptyExit.exitCode}, signal: ${ptyExit.signal ?? 'none'})`
          : '';
      yield {
        type: 'error',
        catId,
        error: `Antigravity PTY 未在 ${Math.round(timeoutMs / 1000)}s 内写出 MODEL/PLANNER_RESPONSE/DONE transcript${exitHint}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, metadata, timestamp: Date.now() };
      return;
    }

    yield {
      type: 'text',
      catId,
      content: response,
      metadata,
      timestamp: Date.now(),
    };
    yield { type: 'done', catId, metadata, timestamp: Date.now() };
  } catch (err) {
    yield {
      type: 'error',
      catId,
      error: err instanceof Error ? err.message : String(err),
      metadata,
      timestamp: Date.now(),
    };
    yield { type: 'done', catId, metadata, timestamp: Date.now() };
  } finally {
    killPty(term);
  }
}
