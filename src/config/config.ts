import fs from 'node:fs';
import path from 'node:path';

export type MultipleChoiceStrategy = 'random' | 'first' | 'last' | 'skip';
export type FreeTextStrategy = 'fixed_text' | 'echo_question' | 'skip';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** Poll page to watch. Normally given on the command line or at the prompt. */
  url: string | null;
  /** Detect and log polls but never click or type. */
  dryRun: boolean;
  /** Optional automatic stop. null means run until the user stops it. */
  stopAfterMinutes: number | null;
  /** Keep the computer from idle-sleeping while the bot runs (macOS only). */
  keepAwake: boolean;
  /**
   * Where the page shows whether you are signed in (Poll Everywhere does),
   * do not answer while signed out: the response would not be credited to you.
   */
  requireSignIn: boolean;
  response: {
    multipleChoice: MultipleChoiceStrategy;
    freeText: FreeTextStrategy;
    fixedText: string;
    /** Random pause between seeing a poll and responding to it. */
    delayMs: { min: number; max: number };
    /** How long to wait for the page to show the response was accepted. */
    confirmTimeoutMs: number;
    /** Attempts per poll appearance, each one gated on the page still showing it unanswered. */
    maxAttempts: number;
    /** Pause before the second attempt; doubles for each attempt after that, up to 30 seconds. */
    retryDelayMs: number;
  };
  monitor: {
    /** React to page changes as they happen. When false, only the periodic read is used. */
    eventDriven: boolean;
    /** Wait this long after a page change before reading the page. */
    debounceMs: number;
    /** Read the page at least this often even with no change events. */
    fallbackPollMs: number;
    snapshotTimeoutMs: number;
    navigationTimeoutMs: number;
    /** An unrecognised page lasting this long is reported to the user. */
    unknownAlertMs: number;
    /** Being on some other URL for this long triggers a return to the poll page. */
    awayGraceMs: number;
    /**
     * A poll must have been showing as open, in the same page element, for this
     * long before it is answered. Covers the moment after a page (re)draws a
     * poll in which earlier responses have not been loaded yet.
     */
    settleMs: number;
    /** Reload the page this often to resynchronise. 0 disables. */
    resyncMs: number;
    /** Reload if the page's own live connection has been down this long. */
    pushDownMs: number;
    recovery: { initialMs: number; maxMs: number };
  };
  browser: {
    headless: boolean;
    /** null uses Playwright's bundled Chromium; "chrome" uses installed Google Chrome. */
    channel: string | null;
    profileDir: string;
  };
  dedupe: {
    file: string;
    /** Earlier answers older than this are ignored when deciding whether a poll is new. */
    windowHours: number;
    retainDays: number;
    /**
     * A poll answered before must look open for this long before the bot reloads the
     * page to check whether a new response is really wanted.
     */
    reanswerSettleMs: number;
    /** The page must show something else for this long for a returning poll to count as asked again. */
    separationMs: number;
  };
  logging: {
    dir: string;
    level: LogLevel;
    redactQuestionText: boolean;
    screenshotOnUnknown: boolean;
    retainDays: number;
  };
  notify: {
    desktop: boolean;
    sound: boolean;
    /** While the bot is blocked waiting for you, repeat the notification this often. 0 = once. */
    remindMs: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  url: null,
  dryRun: false,
  stopAfterMinutes: null,
  keepAwake: true,
  requireSignIn: true,
  response: {
    multipleChoice: 'random',
    freeText: 'fixed_text',
    fixedText: 'value',
    delayMs: { min: 2000, max: 8000 },
    confirmTimeoutMs: 10000,
    maxAttempts: 5,
    retryDelayMs: 5000,
  },
  monitor: {
    eventDriven: true,
    debounceMs: 250,
    fallbackPollMs: 5000,
    snapshotTimeoutMs: 5000,
    navigationTimeoutMs: 30000,
    unknownAlertMs: 60000,
    awayGraceMs: 20000,
    settleMs: 1500,
    resyncMs: 60000,
    pushDownMs: 10000,
    recovery: { initialMs: 1000, maxMs: 5000 },
  },
  browser: {
    headless: false,
    channel: null,
    profileDir: '.data/profile',
  },
  dedupe: {
    file: '.data/answered.json',
    windowHours: 12,
    retainDays: 30,
    reanswerSettleMs: 3000,
    separationMs: 3000,
  },
  logging: {
    dir: 'logs',
    level: 'info',
    redactQuestionText: false,
    screenshotOnUnknown: true,
    retainDays: 30,
  },
  notify: { desktop: true, sound: true, remindMs: 120000 },
};

type Spec =
  | { type: 'boolean' }
  | { type: 'string'; nullable?: boolean; nonEmpty?: boolean; oneOf?: readonly string[] }
  | { type: 'number'; nullable?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: 'object'; fields: Record<string, Spec> };

const ms = (min: number, max = 24 * 60 * 60 * 1000): Spec => ({ type: 'number', integer: true, min, max });

const CONFIG_SPEC: Spec = {
  type: 'object',
  fields: {
    url: { type: 'string', nullable: true, nonEmpty: true },
    dryRun: { type: 'boolean' },
    stopAfterMinutes: { type: 'number', nullable: true, min: 0.01, max: 7 * 24 * 60 },
    keepAwake: { type: 'boolean' },
    requireSignIn: { type: 'boolean' },
    response: {
      type: 'object',
      fields: {
        multipleChoice: { type: 'string', oneOf: ['random', 'first', 'last', 'skip'] },
        freeText: { type: 'string', oneOf: ['fixed_text', 'echo_question', 'skip'] },
        fixedText: { type: 'string', nonEmpty: true },
        delayMs: { type: 'object', fields: { min: ms(0, 600000), max: ms(0, 600000) } },
        confirmTimeoutMs: ms(500, 120000),
        maxAttempts: { type: 'number', integer: true, min: 1, max: 10 },
        retryDelayMs: ms(0, 600000),
      },
    },
    monitor: {
      type: 'object',
      fields: {
        eventDriven: { type: 'boolean' },
        debounceMs: ms(20, 10000),
        fallbackPollMs: ms(250, 600000),
        snapshotTimeoutMs: ms(250, 120000),
        navigationTimeoutMs: ms(1000, 600000),
        unknownAlertMs: ms(1000),
        awayGraceMs: ms(1000),
        settleMs: ms(0, 600000),
        resyncMs: ms(0),
        pushDownMs: ms(500),
        recovery: { type: 'object', fields: { initialMs: ms(50, 600000), maxMs: ms(50, 600000) } },
      },
    },
    browser: {
      type: 'object',
      fields: {
        headless: { type: 'boolean' },
        channel: { type: 'string', nullable: true, nonEmpty: true },
        profileDir: { type: 'string', nonEmpty: true },
      },
    },
    dedupe: {
      type: 'object',
      fields: {
        file: { type: 'string', nonEmpty: true },
        windowHours: { type: 'number', min: 0, max: 24 * 365 },
        retainDays: { type: 'number', min: 0, max: 3650 },
        reanswerSettleMs: ms(0, 600000),
        separationMs: ms(0, 600000),
      },
    },
    logging: {
      type: 'object',
      fields: {
        dir: { type: 'string', nonEmpty: true },
        level: { type: 'string', oneOf: ['debug', 'info', 'warn', 'error'] },
        redactQuestionText: { type: 'boolean' },
        screenshotOnUnknown: { type: 'boolean' },
        retainDays: { type: 'number', min: 0, max: 3650 },
      },
    },
    notify: {
      type: 'object',
      fields: { desktop: { type: 'boolean' }, sound: { type: 'boolean' }, remindMs: ms(0) },
    },
  },
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** A value shaped like Config with every field optional, at any depth. */
export type PartialConfig = DeepPartial<Config>;
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks `value` against `spec`. Missing keys are fine (partial input); unknown keys are errors. */
function check(value: unknown, spec: Spec, where: string, problems: string[]): void {
  const at = where === '' ? 'config' : where;
  if (spec.type === 'object') {
    if (!isPlainObject(value)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = spec.fields[key];
      const childPath = where === '' ? key : `${where}.${key}`;
      if (!child) {
        problems.push(`${childPath} is not a known setting`);
        continue;
      }
      check(value[key], child, childPath, problems);
    }
    return;
  }
  if (value === null) {
    if (spec.type === 'boolean' || !spec.nullable) problems.push(`${at} must not be null`);
    return;
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${at} must be true or false`);
    return;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') {
      problems.push(`${at} must be a string`);
      return;
    }
    if (spec.nonEmpty && value.trim() === '') problems.push(`${at} must not be empty`);
    if (spec.oneOf && !spec.oneOf.includes(value)) problems.push(`${at} must be one of: ${spec.oneOf.join(', ')}`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${at} must be a number`);
    return;
  }
  if (spec.integer && !Number.isInteger(value)) problems.push(`${at} must be a whole number`);
  if (spec.min !== undefined && value < spec.min) problems.push(`${at} must be at least ${spec.min}`);
  if (spec.max !== undefined && value > spec.max) problems.push(`${at} must be at most ${spec.max}`);
}

function merge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return (overlay === undefined ? base : overlay) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    out[key] = merge(out[key], value);
  }
  return out as T;
}

/**
 * Builds a full Config from defaults plus any number of partial layers (later
 * layers win). Throws ConfigError listing every problem found.
 */
export function buildConfig(...layers: unknown[]): Config {
  const problems: string[] = [];
  let config: Config = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    const before = problems.length;
    check(layer, CONFIG_SPEC, '', problems);
    if (problems.length === before) config = merge(config, layer);
  }
  if (problems.length === 0) {
    if (config.response.delayMs.min > config.response.delayMs.max) {
      problems.push('response.delayMs.min must not be greater than response.delayMs.max');
    }
    if (config.monitor.recovery.initialMs > config.monitor.recovery.maxMs) {
      problems.push('monitor.recovery.initialMs must not be greater than monitor.recovery.maxMs');
    }
    if (config.url !== null) {
      try {
        config.url = normalizeUrl(config.url);
      } catch (error) {
        problems.push(`url: ${(error as Error).message}`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Reads a JSON config file. Returns undefined if the file does not exist. */
export function readConfigFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError([`cannot read ${file}: ${(error as Error).message}`]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError([`${file} is not valid JSON: ${(error as Error).message}`]);
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Turns what a person might paste or type into a full URL.
 *   "https://pollev.com/name"  -> unchanged
 *   "pollev.com/name"          -> https://pollev.com/name
 *   "name"                     -> https://pollev.com/name  (a Poll Everywhere presenter name)
 *   "localhost:4173/x"         -> http://localhost:4173/x
 */
export function normalizeUrl(input: string): string {
  let text = input.trim();
  if (text === '') throw new Error('the link is empty');
  if (/\s/.test(text)) throw new Error('the link must not contain spaces');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (LOOPBACK.test(text)) text = `http://${text}`;
    else if (/^[A-Za-z0-9_-]+$/.test(text)) text = `https://pollev.com/${text}`;
    else text = `https://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${input}" is not a valid link`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('the link must start with http:// or https://');
  }
  if (!url.hostname.includes('.') && !/^(localhost|\[::1\])$/i.test(url.hostname)) {
    throw new Error(`"${input}" is not a valid link`);
  }
  return url.toString();
}

/** Root of the project: the directory that holds package.json. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Resolves a config path that may be relative to the project root. */
export function resolvePath(p: string, root: string = PROJECT_ROOT): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}
