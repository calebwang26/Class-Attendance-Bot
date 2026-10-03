import fs from 'node:fs';
import path from 'node:path';
import { BrowserLaunchError, BrowserMonitor } from './browser/monitor.ts';
import { HELP, parseCliArgs, UsageError } from './cli/args.ts';
import { askForUrl, readLastUrl, writeLastUrl } from './cli/prompt.ts';
import {
  buildConfig,
  ConfigError,
  normalizeUrl,
  PROJECT_ROOT,
  readConfigFile,
  resolvePath,
  type Config,
} from './config/config.ts';
import { AnsweredStore } from './dedupe/store.ts';
import { Logger, makeSessionId, pruneOldFiles } from './logger/logger.ts';
import { Orchestrator, screenshotDirFor, type Summary } from './orchestrator/orchestrator.ts';
import { acquireInstanceLock } from './system/instanceLock.ts';
import { keepAwake } from './system/keepAwake.ts';
import { notifyUser } from './system/notify.ts';
import { clock, errorMessage } from './util/time.ts';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function describeAnswers(config: Config): string {
  const choice: Record<Config['response']['multipleChoice'], string> = {
    random: 'a random option',
    first: 'the first option',
    last: 'the last option',
    skip: 'not answered',
  };
  const text: Record<Config['response']['freeText'], string> = {
    fixed_text: `"${config.response.fixedText}"`,
    echo_question: 'the question text',
    skip: 'not answered',
  };
  return `multiple choice → ${choice[config.response.multipleChoice]}; free text → ${text[config.response.freeText]}`;
}

function printSummary(summary: Summary, logFile: string): void {
  const start = clock(new Date(summary.startedAt));
  const stop = clock(new Date(summary.stoppedAt));
  out();
  out('Session summary');
  out(`  Ran:               ${start} – ${stop}`);
  out(`  Stopped because:   ${summary.stopReason}`);
  out(`  Polls seen:        ${summary.detected}`);
  out(`  Answered:          ${summary.answered}`);
  out(`  Already answered:  ${summary.alreadyAnswered}`);
  out(`  Could not answer:  ${summary.failed}`);
  out(`  Unsupported type:  ${summary.unsupported}`);
  out(`  Left alone:        ${summary.skipped}`);
  out(`  Page recoveries:   ${summary.recoveries}`);
  const relative = path.relative(process.cwd(), logFile);
  out(`  Log file:          ${relative && !relative.startsWith('..') ? relative : logFile}`);
}

/** Opens the bot's browser on `url` and waits until the person closes it. Nothing is monitored. */
async function runLogin(config: Config, url: string): Promise<number> {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const monitor = new BrowserMonitor(config, resolvePath(config.browser.profileDir), {
    onChange: () => undefined,
    onCrash: () => undefined,
    onClosed: () => finish(),
    onDialog: () => undefined,
  });
  await monitor.launch();
  const onSignal = (): void => finish();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  out("The bot's browser is open.");
  out('  1. Sign in there (on Poll Everywhere, click "Log in" in the sidebar).');
  out('  2. Optionally close the cookie notice.');
  out('  3. Close the browser window when you are done. Your sign-in is kept for next time.');
  try {
    await monitor.navigate(url);
  } catch (error) {
    out(`Could not open ${url}: ${errorMessage(error)}`);
  }
  await done;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await monitor.close();
  out('Browser closed. Start the bot with:  npm start');
  return 0;
}

async function runBot(config: Config, url: string): Promise<number> {
  const logDir = resolvePath(config.logging.dir);
  const screenshotDir = screenshotDirFor(logDir);
  const logger = new Logger({
    dir: logDir,
    level: config.logging.level,
    redactQuestionText: config.logging.redactQuestionText,
    sessionId: makeSessionId(),
  });
  pruneOldFiles(logDir, config.logging.retainDays);
  pruneOldFiles(screenshotDir, Math.min(config.logging.retainDays, 7));

  let opened;
  try {
    opened = AnsweredStore.open(resolvePath(config.dedupe.file), { retainDays: config.dedupe.retainDays });
  } catch (error) {
    out(`Cannot use the answered-polls file (${resolvePath(config.dedupe.file)}): ${errorMessage(error)}`);
    out('Fix the folder permissions or change "dedupe.file" in the settings, then start again.');
    return 1;
  }
  if (opened.quarantinedTo) {
    logger.warn('store.quarantined', {
      movedTo: opened.quarantinedTo,
      message: `The answered-polls file was unreadable. It was moved aside (${path.basename(opened.quarantinedTo)}) and a new one started.`,
    });
  }

  const awake = keepAwake(config.keepAwake);
  const orchestrator = new Orchestrator({
    config,
    logger,
    store: opened.store,
    profileDir: resolvePath(config.browser.profileDir),
    screenshotDir,
    notify: (title, message) => notifyUser(title, message, config.notify),
  });

  out('Poll bot');
  out(`  Link:     ${url}`);
  out(`  Answers:  ${describeAnswers(config)}${config.dryRun ? '   (DRY RUN: nothing will be sent)' : ''}`);
  out(`  Runs:     ${config.stopAfterMinutes === null ? 'until you stop it' : `for ${config.stopAfterMinutes} minutes, or until you stop it`}`);
  out("  Stop:     press Ctrl+C here, or close the bot's browser window");
  if (config.keepAwake && process.platform === 'darwin') {
    out(`  Sleep:    ${awake.active ? 'the computer is kept awake while the bot runs (keep the lid open)' : 'could not prevent sleep'}`);
  }
  out();

  let signals = 0;
  const onSignal = (name: string): void => {
    signals += 1;
    if (signals > 1) process.exit(130);
    orchestrator.stop(`stopped from the terminal (${name})`);
  };
  const onInt = (): void => onSignal('Ctrl+C');
  const onTerm = (): void => onSignal('terminate signal');
  const onHup = (): void => onSignal('terminal closed');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  const onRejection = (reason: unknown): void => {
    logger.warn('process.unhandled_rejection', { error: errorMessage(reason) });
  };
  process.on('unhandledRejection', onRejection);

  let code = 0;
  try {
    const summary = await orchestrator.run(url);
    printSummary(summary, logger.file);
  } catch (error) {
    code = 1;
    if (error instanceof BrowserLaunchError) out(error.message);
    else out(`The bot stopped because of an unexpected problem: ${errorMessage(error)}`);
    logger.error('session.crash', { error: errorMessage(error) });
  } finally {
    awake.stop();
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGHUP', onHup);
    process.removeListener('unhandledRejection', onRejection);
  }
  return code;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      out(`${error.message}\n`);
      out(HELP);
      return 2;
    }
    throw error;
  }
  if (args.mode === 'help') {
    out(HELP);
    return 0;
  }
  if (args.mode === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string };
    out(pkg.version ?? 'unknown');
    return 0;
  }

  let config: Config;
  try {
    const file = args.configPath ? path.resolve(args.configPath) : path.join(PROJECT_ROOT, 'pollbot.config.json');
    const fromFile = readConfigFile(file);
    if (args.configPath && fromFile === undefined) throw new ConfigError([`${file} does not exist`]);
    config = buildConfig(fromFile, args.overrides);
  } catch (error) {
    if (error instanceof ConfigError) {
      out(error.message);
      return 2;
    }
    throw error;
  }

  const stateFile = path.join(path.dirname(resolvePath(config.dedupe.file)), 'state.json');
  let url: string | null = null;
  try {
    if (args.url !== null) url = normalizeUrl(args.url);
    else if (config.url !== null) url = config.url;
  } catch (error) {
    out(`That link does not look right: ${(error as Error).message}`);
    return 2;
  }
  if (url === null) {
    if (!process.stdin.isTTY) {
      out('No poll link given. Run:  npm start -- <link>');
      return 2;
    }
    url = await askForUrl(readLastUrl(stateFile));
    if (url === null) return 0;
  }
  writeLastUrl(stateFile, url);

  const lock = acquireInstanceLock(resolvePath(config.browser.profileDir));
  if (!lock.ok) {
    out(lock.reason);
    return 1;
  }
  try {
    return args.mode === 'login' ? await runLogin(config, url) : await runBot(config, url);
  } catch (error) {
    if (error instanceof BrowserLaunchError) {
      out(error.message);
      return 1;
    }
    throw error;
  } finally {
    lock.release();
  }
}

// Run only when started directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      out(`Unexpected problem: ${errorMessage(error)}`);
      process.exit(1);
    },
  );
}
