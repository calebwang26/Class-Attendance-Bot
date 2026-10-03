import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, type Config, type PartialConfig } from '../../src/config/config.ts';
import { AnsweredStore } from '../../src/dedupe/store.ts';
import { Logger, type LogEvent } from '../../src/logger/logger.ts';
import { Orchestrator, type Summary } from '../../src/orchestrator/orchestrator.ts';
import { MockSite, startMockSite } from '../../mock-site/server.ts';

/** Settings that make the bot quick enough for tests while keeping every mechanism switched on. */
export const FAST: PartialConfig = {
  keepAwake: false,
  response: {
    multipleChoice: 'first',
    delayMs: { min: 40, max: 80 },
    confirmTimeoutMs: 4000,
    maxAttempts: 3,
    retryDelayMs: 300,
  },
  monitor: {
    debounceMs: 50,
    fallbackPollMs: 400,
    snapshotTimeoutMs: 3000,
    navigationTimeoutMs: 8000,
    unknownAlertMs: 1000,
    awayGraceMs: 1000,
    settleMs: 150,
    resyncMs: 0,
    recovery: { initialMs: 100, maxMs: 600 },
  },
  browser: { headless: true },
  dedupe: { reanswerSettleMs: 900, separationMs: 400 },
  logging: { level: 'debug', screenshotOnUnknown: false },
  notify: { desktop: false, sound: false, remindMs: 0 },
};

export interface Harness {
  site: MockSite;
  bot: Orchestrator;
  logger: Logger;
  config: Config;
  /** Scratch directory holding the profile, the answered-polls file and logs. */
  dir: string;
  /** Everything the bot told the user through notifications. */
  notifications: { title: string; message: string }[];
  /** Lines the bot printed for the user. */
  lines: string[];
  events(name: string): LogEvent[];
  /** Resolves with the first matching event, or throws after `timeoutMs`. */
  waitForEvent(name: string, predicate?: (event: LogEvent) => boolean, timeoutMs?: number): Promise<LogEvent>;
  /** Waits until `check` returns true, or throws after `timeoutMs`. */
  until(check: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Stops the bot and returns its summary. Idempotent. */
  stop(): Promise<Summary>;
}

export function makeScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-test-'));
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await delay(25);
  }
}

/**
 * Starts the bot against `url`. `dir` lets a test restart the bot on the same
 * browser profile and answered-polls file.
 */
export async function startBot(
  site: MockSite,
  url: string,
  options: { overrides?: PartialConfig; dir?: string; rng?: () => number } = {},
): Promise<Harness> {
  const dir = options.dir ?? makeScratchDir();
  const config = buildConfig(FAST, options.overrides, {
    browser: { profileDir: path.join(dir, 'profile') },
    dedupe: { file: path.join(dir, 'answered.json') },
    logging: { dir: path.join(dir, 'logs') },
  });
  const lines: string[] = [];
  const logger = new Logger({
    dir: config.logging.dir,
    level: config.logging.level,
    redactQuestionText: config.logging.redactQuestionText,
    sessionId: `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    print: (line) => lines.push(line),
  });
  const { store } = AnsweredStore.open(config.dedupe.file, { retainDays: config.dedupe.retainDays });
  const notifications: { title: string; message: string }[] = [];
  const bot = new Orchestrator({
    config,
    logger,
    store,
    profileDir: config.browser.profileDir,
    screenshotDir: path.join(dir, 'screenshots'),
    notify: (title, message) => notifications.push({ title, message }),
    ...(options.rng ? { rng: options.rng } : {}),
  });

  let summary: Summary | null = null;
  let failure: unknown = null;
  const done = bot.run(url).then(
    (s) => {
      summary = s;
    },
    (error: unknown) => {
      failure = error;
    },
  );

  const events = (name: string): LogEvent[] => logger.events.filter((e) => e.event === name);
  const until = (check: () => boolean, what: string, timeoutMs = 10000): Promise<void> =>
    waitUntil(() => {
      if (failure) throw failure;
      return check();
    }, what, timeoutMs);

  const harness: Harness = {
    site,
    bot,
    logger,
    config,
    dir,
    notifications,
    lines,
    events,
    until,
    async waitForEvent(name, predicate = () => true, timeoutMs = 10000) {
      let found: LogEvent | undefined;
      try {
        await until(() => {
          found = events(name).find(predicate);
          return found !== undefined;
        }, `event "${name}"`, timeoutMs);
      } catch (error) {
        const seen = [...new Set(logger.events.map((e) => e.event))].join(', ');
        throw new Error(`${(error as Error).message}\n  events seen: ${seen}\n  last lines:\n    ${lines.slice(-12).join('\n    ')}`);
      }
      return found as LogEvent;
    },
    async stop() {
      bot.stop('test finished');
      await done;
      if (failure) throw failure;
      return summary as unknown as Summary;
    },
  };

  await harness.waitForEvent('page.opened', undefined, 20000);
  return harness;
}

export { startMockSite };

/** Removes a scratch directory, ignoring errors (the browser may still be letting go of files). */
export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Left for the OS to clear from its temp directory.
  }
}

export interface WithBotOptions {
  overrides?: PartialConfig;
  /** Which page the bot is pointed at. Defaults to the Poll Everywhere-style participant page. */
  url?: (site: MockSite) => string;
  /** Runs before the bot starts, e.g. to activate a poll or set a fault. */
  before?: (site: MockSite) => void | Promise<void>;
  rng?: () => number;
  dir?: string;
  /** Keep the scratch directory afterwards (a later bot in the same test reuses it). */
  keepDir?: boolean;
}

/** Runs `body` with a fresh mock site and a running bot, and always cleans up. */
export async function withBot(options: WithBotOptions, body: (h: Harness, site: MockSite) => Promise<void>): Promise<void> {
  const site = await startMockSite();
  let harness: Harness | null = null;
  try {
    if (options.before) await options.before(site);
    harness = await startBot(site, (options.url ?? ((s) => s.participantUrl()))(site), {
      ...(options.overrides ? { overrides: options.overrides } : {}),
      ...(options.dir ? { dir: options.dir } : {}),
      ...(options.rng ? { rng: options.rng } : {}),
    });
    await body(harness, site);
  } finally {
    if (harness) await harness.stop().catch(() => undefined);
    await site.close();
    if (harness && !options.keepDir) cleanup(harness.dir);
  }
}

/** The id the mock site gave the bot's browser. */
export function botParticipant(site: MockSite): string {
  const [first] = [...site.participants];
  if (!first) throw new Error('no participant has loaded a page yet');
  return first;
}

export const PLANETS = ['Mercury', 'Venus', 'Earth', 'Mars'];
