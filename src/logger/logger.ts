import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../config/config.ts';
import { clock } from '../util/time.ts';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are poll content. They are hashed when redaction is on. */
const CONTENT_KEYS = new Set([
  'question',
  'options',
  'response',
  'label',
  'text',
  'pageText',
  'statusText',
  // Evidence quotes what the page displayed, which can include an option label.
  'evidence',
]);

/** Keys that must never reach a log, whatever the caller passes. */
const FORBIDDEN_KEYS = /^(cookie|cookies|password|passwd|token|authorization|headers|set-cookie)$/i;

export interface LogEvent {
  ts: string;
  session: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  dir: string;
  level: LogLevel;
  redactQuestionText: boolean;
  sessionId: string;
  /** Called with a human-readable line for events worth showing. Defaults to stdout. */
  print?: (line: string) => void;
  /** Set false to keep events in memory only (used by tests). */
  writeFile?: boolean;
  now?: () => Date;
}

export function hashText(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') return hashText(value);
  if (Array.isArray(value)) return value.map(redact);
  return value;
}

function sanitize(data: Record<string, unknown>, redactContent: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (FORBIDDEN_KEYS.test(key) || value === undefined) continue;
    out[key] = redactContent && CONTENT_KEYS.has(key) ? redact(value) : value;
  }
  return out;
}

/**
 * Structured event log. Every event is one JSON object per line in
 * `<dir>/session-<id>.jsonl`; a short human-readable form goes to the terminal.
 */
export class Logger {
  readonly file: string;
  readonly sessionId: string;
  /** All events of this session, newest last. Bounded; used for the summary and by tests. */
  readonly events: LogEvent[] = [];
  private readonly options: LoggerOptions;
  private readonly print: (line: string) => void;
  private fileBroken = false;
  /** The last message shown at the terminal, so callers can avoid repeating themselves. */
  lastMessage: string | null = null;

  constructor(options: LoggerOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.file = path.join(options.dir, `session-${options.sessionId}.jsonl`);
    this.print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
    if (options.writeFile !== false) fs.mkdirSync(options.dir, { recursive: true });
  }

  debug(event: string, data: Record<string, unknown> = {}): void {
    this.log('debug', event, data);
  }
  info(event: string, data: Record<string, unknown> = {}): void {
    this.log('info', event, data);
  }
  warn(event: string, data: Record<string, unknown> = {}): void {
    this.log('warn', event, data);
  }
  error(event: string, data: Record<string, unknown> = {}): void {
    this.log('error', event, data);
  }

  /** Prints a line for the person at the terminal without recording an event. */
  say(message: string): void {
    this.print(`${clock(this.now())}  ${message}`);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private log(level: LogLevel, event: string, data: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.options.level]) return;
    const now = this.now();
    const record: LogEvent = {
      ts: now.toISOString(),
      session: this.sessionId,
      level,
      event,
      ...sanitize(data, this.options.redactQuestionText),
    };
    // The terminal message may quote the question; keep it out of the file when redacting.
    if (this.options.redactQuestionText) delete record['message'];
    this.events.push(record);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    if (this.options.writeFile !== false && !this.fileBroken) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
      } catch (error) {
        // Logging must never take the bot down. Say so once and carry on.
        this.fileBroken = true;
        this.print(`${clock(now)}  WARNING: cannot write the log file (${(error as Error).message}). Continuing without it.`);
      }
    }
    const message = typeof data['message'] === 'string' ? (data['message'] as string) : undefined;
    if (message !== undefined) {
      this.lastMessage = message;
      const prefix = level === 'error' ? 'ERROR: ' : level === 'warn' ? 'WARNING: ' : '';
      this.print(`${clock(now)}  ${prefix}${message}`);
    }
  }
}

/** Session id: local date and time, safe for file names. e.g. 2026-10-02_080112 */
export function makeSessionId(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Deletes files in `dir` older than `retainDays`. Returns how many were removed. */
export function pruneOldFiles(dir: string, retainDays: number, now: Date = new Date()): number {
  if (retainDays <= 0) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - retainDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file);
        removed += 1;
      }
    } catch {
      // A file we cannot stat or remove is not worth failing over.
    }
  }
  return removed;
}
