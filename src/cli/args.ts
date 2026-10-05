import { parseArgs } from 'node:util';
import type { PartialConfig } from '../config/config.ts';

export interface CliArgs {
  mode: 'run' | 'login' | 'help' | 'version';
  /** Link given on the command line, not yet normalised. */
  url: string | null;
  configPath: string | null;
  /** Lecture times given with --hours (not yet checked), or 'any' for --any-time, or null to ask. */
  hours: string | 'any' | null;
  /** Settings given as flags; they override the config file. */
  overrides: PartialConfig;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const HELP = `Poll bot — watches a live poll page and answers each poll once.

Usage
  npm start                      ask for the poll link, then run until stopped
  npm start -- <link>            run on this link (e.g. pollev.com/yourpresenter)
  npm run login -- <link>        open the bot's browser so you can sign in, then close it
  npm run dry-run -- <link>      watch and log polls without answering

When it starts, the bot asks when your lecture is, and only answers polls then
(5 minutes either side). Press Enter to reuse your last lecture times.

Stop it with Ctrl+C in this window, or by closing the bot's browser window.

Options (after "--")
  --dry-run                 detect and log polls, never click or type
  --choice <how>            multiple choice: random (default), first, last, skip
  --free-text <how>         free text: fixed_text (default), echo_question, skip
  --text <string>           the text sent to free-text polls (default: value)
  --hours "<times>"         lecture times, instead of being asked (e.g. "Mon Wed Fri 8:00-9:30")
  --any-time                answer polls at any time, instead of being asked
  --stop-after <minutes>    stop by itself after this long (default: never)
  --chrome                  use installed Google Chrome instead of the bundled Chromium
  --headless                run the browser without a window
  --allow-guest             answer even when not signed in (responses will be anonymous)
  --no-keep-awake           let the computer sleep on its own schedule
  --config <file>           settings file (default: pollbot.config.json if present)
  --login                   only open the bot's browser so you can sign in
  --help, --version
`;

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        login: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        choice: { type: 'string' },
        'free-text': { type: 'string' },
        text: { type: 'string' },
        'stop-after': { type: 'string' },
        hours: { type: 'string' },
        'any-time': { type: 'boolean' },
        chrome: { type: 'boolean' },
        headless: { type: 'boolean' },
        'no-keep-awake': { type: 'boolean' },
        'allow-guest': { type: 'boolean' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new UsageError(`Expected one link, got ${positionals.length}: ${positionals.join(' ')}`);
  }

  if (values.hours !== undefined && values['any-time']) {
    throw new UsageError('Give either --hours or --any-time, not both');
  }
  if (values.hours !== undefined && values.hours.trim() === '') throw new UsageError('--hours needs your lecture times, e.g. --hours "Mon Wed Fri 8:00-9:30"');

  const overrides: PartialConfig = {};
  const response: NonNullable<PartialConfig['response']> = {};
  if (values['dry-run']) overrides.dryRun = true;
  if (values.choice !== undefined) response.multipleChoice = values.choice as never;
  if (values['free-text'] !== undefined) response.freeText = values['free-text'] as never;
  if (values.text !== undefined) response.fixedText = values.text;
  if (Object.keys(response).length > 0) overrides.response = response;
  if (values['stop-after'] !== undefined) {
    const minutes = Number(values['stop-after']);
    if (!Number.isFinite(minutes)) throw new UsageError('--stop-after needs a number of minutes');
    overrides.stopAfterMinutes = minutes;
  }
  const browser: NonNullable<PartialConfig['browser']> = {};
  if (values.chrome) browser.channel = 'chrome';
  if (values.headless) browser.headless = true;
  if (Object.keys(browser).length > 0) overrides.browser = browser;
  if (values['no-keep-awake']) overrides.keepAwake = false;
  if (values['allow-guest']) overrides.requireSignIn = false;

  let mode: CliArgs['mode'] = 'run';
  if (values.help) mode = 'help';
  else if (values.version) mode = 'version';
  else if (values.login) mode = 'login';

  return {
    mode,
    url: positionals[0] ?? null,
    configPath: values.config ?? null,
    hours: values['any-time'] ? 'any' : (values.hours ?? null),
    overrides,
  };
}
