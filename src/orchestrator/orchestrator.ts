import path from 'node:path';
import { BrowserMonitor } from '../browser/monitor.ts';
import type { Config } from '../config/config.ts';
import { decide, type PreviousAnswer, type Recheck, type SkipReason } from '../dedupe/decide.ts';
import type { AnsweredStore } from '../dedupe/store.ts';
import type { Logger } from '../logger/logger.ts';
import { locationKey, recognize, sameLocation, sameOrigin, samePresenter, type RecognizeOptions } from '../recognizer/recognize.ts';
import { chooseResponse } from '../selector/select.ts';
import { Submitter } from '../submitter/submit.ts';
import { normalizeText } from '../recognizer/fingerprint.ts';
import { describeLectureHours, describeMoment, isLectureTime, nextLectureStart, type LectureHours } from '../schedule/lectureHours.ts';
import type { Confirmation, PageSnapshot, PlannedResponse, Poll, PollStatus, Recognition, SnapshotPoll } from '../types.ts';
import { AbortError, backoffMs, errorMessage, randomInt } from '../util/time.ts';

export type BotState = 'CONNECTING' | 'WATCHING' | 'RESPONDING' | 'RECOVERING' | 'STOPPED';

export interface Summary {
  sessionId: string;
  url: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: string;
  /** Distinct poll appearances seen. */
  detected: number;
  /** Responses this tool submitted and saw confirmed. */
  answered: number;
  /** Polls the page already showed as answered when first seen. */
  alreadyAnswered: number;
  /** Polls it tried to answer and could not. */
  failed: number;
  /** Polls of a type it does not answer. */
  unsupported: number;
  /** Polls left alone by choice (strategy "skip", dry run, or judged a duplicate). */
  skipped: number;
  /** Polls not answered because they were outside the lecture times. */
  outsideLecture: number;
  /** Times it had to reopen or reload the page to recover. */
  recoveries: number;
}

export interface OrchestratorDeps {
  config: Config;
  logger: Logger;
  store: AnsweredStore;
  /** Absolute path of the browser profile directory. */
  profileDir: string;
  /** Absolute path of the directory for failure screenshots. */
  screenshotDir: string;
  /** Tells the person something needs attention. */
  notify: (title: string, message: string) => void;
  /** Random source in [0, 1). Injected so tests are repeatable. */
  rng?: () => number;
  /** Answer only during these lecture times (widened by `lectureMarginMinutes`). Omitted or null: any time. */
  lectureHours?: LectureHours | null;
  /** The time of day for the lecture-time rule. Injected so tests can move it. */
  clock?: () => Date;
}

/** Longest the bot holds a response back for the page to finish loading earlier responses. */
const RESULTS_WAIT_MS = 6000;
/** Longest pause between two attempts at the same poll. */
const RETRY_CAP_MS = 30000;
/** Longest the bot waits for a request the page is sending before it reloads anyway. */
const SEND_WAIT_MS = 30000;

/** One continuous appearance of a poll on the page. */
interface Instance {
  fingerprint: string;
  poll: Poll;
  firstSeenAt: number;
  /** "poll.detected" has been logged for this appearance. */
  announced: boolean;
  /** Start of the current unbroken run of "open" readings in the same page element. */
  openSince: number | null;
  mountRef: string | null;
  /** When the response delay for this appearance ends. null = not chosen yet. */
  respondAt: number | null;
  failedAttempts: number;
  retryNotBefore: number | null;
  /** When the bot gave up on this appearance, and whether it has had its one second chance. */
  gaveUpAt: number | null;
  secondChanceUsed: boolean;
  /** This appearance is currently counted as "could not answer" in the summary. */
  countedFailed: boolean;
  lastStatus: PollStatus | null;
  /** Things already reported for this appearance, so each is said once. */
  reported: Set<string>;
}

/**
 * A response to a poll may already be on the server, but that is not known.
 * Kept per poll (not per appearance), so it survives the poll going away and
 * coming back. Settled only by the page showing the poll as answered, or by a
 * page loaded after `checkAfter` that fetched earlier responses and still shows
 * the poll open.
 */
interface Doubt {
  /** reopened: answered before, now looks open. unconfirmed: an attempt's outcome is unknown. */
  kind: 'reopened' | 'unconfirmed';
  /** When the doubt arose. */
  since: number;
  /** Only a page loaded after this time can settle it. */
  checkAfter: number;
  /** For "unconfirmed": what the attempt tried to send. */
  plan: PlannedResponse | null;
}

interface AnsweredInfo extends PreviousAnswer {}

interface Recovery {
  reason: string;
  /** A routine reload, not a fault. */
  planned: boolean;
  attempt: number;
  nextAt: number;
  needNewPage: boolean;
}

/** Wakes the main loop at the earliest time anyone has asked for. */
class Waker {
  private due = Number.POSITIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  private resolver: (() => void) | null = null;
  private pending = false;

  request(at: number): void {
    if (at >= this.due) return;
    this.due = at;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), Math.max(0, at - Date.now()));
  }

  private fire(): void {
    this.timer = null;
    this.due = Number.POSITIVE_INFINITY;
    const resolve = this.resolver;
    this.resolver = null;
    if (resolve) resolve();
    else this.pending = true;
  }

  /** Resolves at the next requested time (immediately if one has already passed). */
  wait(): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }

  wakeNow(): void {
    this.request(0);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = Number.POSITIVE_INFINITY;
  }
}

function quote(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
}

/**
 * The control loop. It is a single serialised loop: read the page, decide,
 * maybe act, then sleep until something changes or a timer is due. Because
 * only one iteration runs at a time, a poll can never be handled twice at
 * once, however many change notifications arrive.
 */
export class Orchestrator {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly store: AnsweredStore;
  private readonly deps: OrchestratorDeps;
  private readonly rng: () => number;
  private readonly monitor: BrowserMonitor;
  private readonly submitter: Submitter;
  private readonly recognizeOptions: RecognizeOptions;
  private readonly waker = new Waker();
  private readonly abort = new AbortController();

  private state: BotState = 'CONNECTING';
  private targetUrl = '';
  private stopReason = '';
  private startedAt = new Date();

  private recovery: Recovery | null = null;
  private snapshotFailures = 0;
  private lastNavAt = 0;
  private everConnected = false;

  private instance: Instance | null = null;
  /** Polls answered (or seen answered), by fingerprint. */
  private readonly answered = new Map<string, AnsweredInfo>();
  /** Polls for which a response may already be on the server, by fingerprint. */
  private readonly doubts = new Map<string, Doubt>();
  /** The current unbroken run of one stable page state. */
  private stableRun: { key: string; since: number } = { key: '', since: 0 };
  private awaySince: number | null = null;
  /** When the bot last had to return to the poll link, to spot a page that keeps leaving. */
  private readonly returns: number[] = [];
  private unknownSince: number | null = null;
  private unknownReported = false;
  private unknownReloaded = false;
  private offlineSince: number | null = null;
  private pushDownSince: number | null = null;
  /** The page's live connection has been seen working since the page last loaded. */
  private pushWasUp = false;
  private authPending = false;
  private needsUser: { key: string; lastNotifiedAt: number } | null = null;
  private storeWarningGiven = false;
  private bannerHintGiven = false;
  /** Last page state written to the log, so each change is recorded once. */
  private lastStateKey = '';
  /** Whether it was lecture time at the last check, to announce changes. null before the first. */
  private lastInLecture: boolean | null = null;
  private readonly recordedDialogs = new Set<string>();

  private readonly counters = {
    detected: 0,
    answered: 0,
    alreadyAnswered: 0,
    failed: 0,
    unsupported: 0,
    skipped: 0,
    outsideLecture: 0,
    recoveries: 0,
  };

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.logger = deps.logger;
    this.store = deps.store;
    this.rng = deps.rng ?? Math.random;
    this.recognizeOptions = { requireSignIn: this.config.requireSignIn };
    this.monitor = new BrowserMonitor(this.config, deps.profileDir, {
      onChange: (reason) => this.onPageChange(reason),
      onCrash: () => this.onCrash(),
      onClosed: (what) => this.onClosed(what),
      onDialog: (type, message) => this.logger.info('page.dialog', { type, text: message.slice(0, 200) }),
    });
    this.submitter = new Submitter(this.monitor, this.config, this.logger, this.recognizeOptions);
  }

  get currentState(): BotState {
    return this.state;
  }

  /** The browser this bot drives. For diagnostics and tests. */
  get browser(): BrowserMonitor {
    return this.monitor;
  }

  /** Asks the loop to finish. Safe to call more than once and from signal handlers. */
  stop(reason: string): void {
    if (this.abort.signal.aborted) return;
    this.stopReason = reason;
    this.abort.abort();
    // Closing the browser makes any page operation in flight fail at once, so the loop ends promptly.
    void this.monitor.close();
    this.waker.wakeNow();
  }

  /** Opens the browser, watches `url` until stopped, and returns a summary. */
  async run(url: string): Promise<Summary> {
    this.targetUrl = url;
    this.startedAt = new Date();
    this.logger.info('session.start', {
      url,
      dryRun: this.config.dryRun,
      multipleChoice: this.config.response.multipleChoice,
      freeText: this.config.response.freeText,
      stopAfterMinutes: this.config.stopAfterMinutes,
      lectureHours: this.deps.lectureHours ? describeLectureHours(this.deps.lectureHours) : 'any time',
      lectureMarginMinutes: this.config.lectureMarginMinutes,
    });

    let stopTimer: NodeJS.Timeout | null = null;
    try {
      try {
        await this.monitor.launch();
      } catch (error) {
        // Stopped while the browser was starting: not an error.
        if (!this.abort.signal.aborted) throw error;
      }
      if (this.config.stopAfterMinutes !== null) {
        stopTimer = setTimeout(
          () => this.stop(`the ${this.config.stopAfterMinutes}-minute limit was reached`),
          this.config.stopAfterMinutes * 60 * 1000,
        );
      }
      this.startRecovery('opening the poll page', { planned: true });
      while (!this.abort.signal.aborted) {
        await this.waker.wait();
        if (this.abort.signal.aborted) break;
        try {
          await this.tick();
        } catch (error) {
          if (error instanceof AbortError || this.abort.signal.aborted) break;
          // A bug or an unexpected page state must not end the session.
          this.logger.error('loop.error', { error: errorMessage(error), message: `Unexpected problem: ${errorMessage(error)}. Carrying on.` });
        }
        this.waker.request(Date.now() + this.config.monitor.fallbackPollMs);
      }
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
      this.waker.cancel();
      this.setState('STOPPED');
      await this.monitor.close();
    }

    const summary: Summary = {
      sessionId: this.logger.sessionId,
      url,
      startedAt: this.startedAt.toISOString(),
      stoppedAt: new Date().toISOString(),
      stopReason: this.stopReason || 'stopped',
      ...this.counters,
    };
    this.logger.info('session.stop', { ...summary });
    return summary;
  }

  // ------------------------------------------------------------------ events from the browser

  private onPageChange(reason: string): void {
    if (reason === 'loaded') {
      // A new document (not merely an in-page address change).
      this.lastNavAt = Date.now();
      this.pushWasUp = false;
      this.pushDownSince = null;
    }
    this.waker.request(Date.now() + this.config.monitor.debounceMs);
  }

  private onCrash(): void {
    this.logger.warn('page.crash', { message: 'The page crashed. Reopening it.' });
    this.startRecovery('the page crashed', { needNewPage: true });
  }

  private onClosed(what: 'page' | 'browser'): void {
    this.stop(what === 'page' ? "the bot's browser tab was closed" : "the bot's browser window was closed");
  }

  // ------------------------------------------------------------------ state and messages

  private setState(next: BotState): void {
    if (this.state === next) return;
    this.logger.debug('state', { from: this.state, to: next });
    this.state = next;
  }

  /** Says a status line once; repeating the same line is suppressed. */
  private status(event: string, message: string, data: Record<string, unknown> = {}): void {
    if (this.logger.lastMessage === message) return;
    this.logger.info(event, { ...data, message });
  }

  private alertUser(key: string, title: string, message: string, data: Record<string, unknown> = {}): void {
    const now = Date.now();
    const repeat = this.needsUser?.key === key;
    if (repeat) {
      const remind = this.config.notify.remindMs;
      if (remind <= 0 || now - (this.needsUser?.lastNotifiedAt ?? 0) < remind) return;
    }
    this.needsUser = { key, lastNotifiedAt: now };
    this.logger.warn('attention', { ...data, key, reminder: repeat, message });
    this.deps.notify(title, message);
  }

  // ------------------------------------------------------------------ recovery

  private startRecovery(reason: string, options: { planned?: boolean; needNewPage?: boolean } = {}): void {
    if (this.abort.signal.aborted) return;
    if (this.recovery) {
      if (options.needNewPage) this.recovery.needNewPage = true;
      if (!options.planned) this.recovery.planned = false;
      this.waker.wakeNow();
      return;
    }
    this.recovery = {
      reason,
      planned: options.planned === true,
      attempt: 0,
      nextAt: 0,
      needNewPage: options.needNewPage === true,
    };
    if (!options.planned) {
      this.counters.recoveries += 1;
      this.logger.warn('recovery.start', { reason });
      this.setState('RECOVERING');
    } else {
      this.logger.debug('reload.planned', { reason });
    }
    this.waker.wakeNow();
  }

  private async tryRecover(): Promise<void> {
    const recovery = this.recovery;
    if (!recovery) return;
    const now = Date.now();
    if (now < recovery.nextAt) {
      this.waker.request(recovery.nextAt);
      return;
    }
    try {
      if (recovery.needNewPage || !this.monitor.page) {
        await this.monitor.replacePage();
        recovery.needNewPage = false;
      }
      await this.monitor.navigate(this.targetUrl);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      recovery.attempt += 1;
      const { initialMs, maxMs } = this.config.monitor.recovery;
      const wait = backoffMs(recovery.attempt - 1, initialMs, maxMs);
      recovery.nextAt = Date.now() + wait;
      const text = errorMessage(error);
      if (/crash|closed|detached/i.test(text) || recovery.attempt % 3 === 0) recovery.needNewPage = true;
      if (recovery.planned) {
        // A routine reload that fails is a real problem from here on.
        recovery.planned = false;
        this.counters.recoveries += 1;
        this.setState('RECOVERING');
      }
      this.logger.warn('recovery.retry', {
        reason: recovery.reason,
        attempt: recovery.attempt,
        retryInMs: wait,
        error: text,
        ...(recovery.attempt === 1 || recovery.attempt % 5 === 0
          ? { message: `Cannot load the poll page (${text}). Retrying every ${Math.round(wait / 1000)}s or so.` }
          : {}),
      });
      this.waker.request(recovery.nextAt);
      return;
    }

    this.recovery = null;
    this.lastNavAt = Date.now();
    this.snapshotFailures = 0;
    this.awaySince = null;
    this.pushDownSince = null;
    this.pushWasUp = false;
    if (!recovery.planned) {
      this.logger.info('recovery.ok', { reason: recovery.reason, attempts: recovery.attempt + 1, message: 'Poll page reloaded.' });
    }
    if (!this.everConnected) {
      this.everConnected = true;
      this.logger.info('page.opened', { url: this.targetUrl });
    }
    this.setState('WATCHING');
    this.waker.request(Date.now() + this.config.monitor.debounceMs);
  }

  // ------------------------------------------------------------------ one pass of the loop

  private async tick(): Promise<void> {
    if (this.recovery) {
      await this.tryRecover();
      return;
    }

    const result = await this.monitor.snapshot();
    if (this.abort.signal.aborted) return;
    if (!result.ok) {
      this.snapshotFailures += 1;
      this.logger.debug('snapshot.failed', { error: result.error, count: this.snapshotFailures });
      if (this.snapshotFailures >= 3) this.startRecovery(`the page stopped responding (${result.error})`, { needNewPage: true });
      else this.waker.request(Date.now() + 500);
      return;
    }
    this.snapshotFailures = 0;

    this.noteLectureTime();
    const snapshot = result.snapshot;
    const recognition = recognize(snapshot, this.recognizeOptions);
    const now = Date.now();
    this.recordPageState(snapshot, recognition);

    // Anything recognised on some other page (a sign-in provider, a link someone
    // followed) is not the poll. Nothing there is ever clicked.
    if (!this.onTarget(snapshot) && (recognition.state === 'poll' || recognition.state === 'waiting')) {
      this.housekeeping(snapshot, recognition, false, now);
      return;
    }
    this.trackRun(recognition, now);

    switch (recognition.state) {
      case 'poll':
        this.clearBlocked();
        await this.handlePoll(recognition, snapshot, now);
        break;
      case 'waiting':
        this.clearBlocked();
        // A waiting screen for a moment (while a page loads, say) does not end the
        // poll's appearance; one that holds does.
        if (this.stableRun.key === 'waiting' && now - this.stableRun.since >= this.config.dedupe.separationMs) {
          this.endInstance();
        } else if (this.instance) {
          this.waker.request(this.stableRun.since + this.config.dedupe.separationMs);
        }
        this.setState('WATCHING');
        this.status('watching', 'Watching — no poll is showing right now.');
        this.cookieHint(snapshot);
        break;
      case 'needs_user':
        this.handleNeedsUser(recognition);
        break;
      case 'unknown':
        this.handleUnknown(recognition.reason, snapshot, now);
        break;
      case 'loading':
        // Normally momentary. If it never ends, say so like any other unrecognised page.
        this.handleUnknown(`still loading: ${recognition.reason}`, snapshot, now);
        break;
    }
    if (recognition.state !== 'unknown' && recognition.state !== 'loading') {
      this.unknownSince = null;
      this.unknownReported = false;
      this.unknownReloaded = false;
    }
    if (this.abort.signal.aborted) return;
    this.housekeeping(snapshot, recognition, this.isBusyWith(recognition), Date.now());
  }

  /** Writes what the page is showing to the log whenever that changes. For diagnosing a session afterwards. */
  private recordPageState(snapshot: PageSnapshot, recognition: Recognition): void {
    const detail =
      recognition.state === 'poll'
        ? `${recognition.poll.kind}:${recognition.status}:${recognition.poll.fingerprint}`
        : recognition.state === 'unknown' || recognition.state === 'loading'
          ? recognition.reason
          : recognition.state === 'needs_user'
            ? recognition.reason
            : '';
    const key = [recognition.state, detail, snapshot.adapter, snapshot.signedIn, snapshot.pushConnected, locationKey(snapshot.url)].join('|');
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.logger.info('page.state', {
      state: recognition.state,
      detail,
      url: locationKey(snapshot.url),
      adapter: snapshot.adapter,
      scopeFound: snapshot.scopeFound,
      signedIn: snapshot.signedIn,
      pushConnected: snapshot.pushConnected,
      liveTab: snapshot.liveTabSelected,
      cookieBanner: snapshot.cookieBanner,
      unknownControls: snapshot.unknownControls,
      siteType: snapshot.poll?.siteType ?? null,
      siteId: snapshot.poll?.siteId ?? null,
      savedResponses: snapshot.poll?.savedResponses ?? null,
      statusText: snapshot.poll?.statusText ?? null,
    });
  }

  /**
   * Whether the page is the poll page. On Poll Everywhere that is any page of
   * the same site that has the activity area; elsewhere it is the exact link.
   */
  private onTarget(snapshot: PageSnapshot): boolean {
    // Poll Everywhere 2.0 serves the presenter's page from pe.app, whichever address was given.
    if (snapshot.adapter === 'pollev2' && snapshot.scopeFound && samePresenter(snapshot.url, this.targetUrl)) return true;
    if (!sameOrigin(snapshot.url, this.targetUrl)) return false;
    if (snapshot.adapter === 'pollev' && snapshot.scopeFound) return true;
    return sameLocation(snapshot.url, this.targetUrl);
  }

  private clearBlocked(): void {
    if (this.authPending || this.needsUser) {
      this.logger.info('attention.cleared', { message: 'All set — carrying on.' });
    }
    this.authPending = false;
    this.needsUser = null;
  }

  private cookieHint(snapshot: PageSnapshot): void {
    if (!snapshot.cookieBanner || this.bannerHintGiven) return;
    this.bannerHintGiven = true;
    this.logger.info('hint.cookie_banner', {
      message: "Tip: the page is showing a cookie notice. You can close it in the bot's browser window; the bot works either way.",
    });
  }

  /** Notes how long the page has stably shown one thing, and what that implies for earlier answers. */
  private trackRun(recognition: Recognition, now: number): void {
    const key =
      recognition.state === 'poll' ? `poll:${recognition.poll.fingerprint}` : recognition.state === 'waiting' ? 'waiting' : null;
    // Loading, unknown and blocked states neither count as "something else" nor break a run.
    if (key === null) return;
    if (this.stableRun.key !== key) {
      this.stableRun = { key, since: now };
      return;
    }
    if (now - this.stableRun.since < this.config.dedupe.separationMs) return;
    for (const [fingerprint, info] of this.answered) {
      if (!info.separated && key !== `poll:${fingerprint}`) info.separated = true;
    }
  }

  private endInstance(): void {
    this.instance = null;
  }

  private handleNeedsUser(recognition: Extract<Recognition, { state: 'needs_user' }>): void {
    if (recognition.reason === 'dialog') {
      this.recordDialog(recognition.detail);
      this.alertUser(
        `dialog:${recognition.detail}`,
        'Poll bot needs you',
        `The page is showing a dialog (${quote(recognition.detail, 60)}). Please deal with it in the bot's browser window.`,
        { reason: recognition.reason },
      );
      return;
    }
    this.authPending = true;
    const message =
      recognition.reason === 'signed_out'
        ? "You are not signed in to Poll Everywhere in the bot's browser, so responses would not be credited to you. Click \"Log in\" in the bot's window and sign in; the bot continues by itself afterwards."
        : "The page wants you to sign in or register. Please do that in the bot's browser window; the bot continues by itself afterwards.";
    this.alertUser('auth', 'Poll bot needs you to sign in', message, {
      reason: recognition.reason,
      detail: recognition.detail,
    });
  }

  /** Logs a dialog's buttons and markup and saves a screenshot, once per dialog per session. */
  private recordDialog(title: string): void {
    if (this.recordedDialogs.has(title)) return;
    this.recordedDialogs.add(title);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    void (async () => {
      const details = await this.monitor.describeDialog();
      const screenshot = await this.monitor.screenshot(this.deps.screenshotDir, `dialog-${stamp}.png`);
      this.logger.info('dialog.recorded', { title, ...(details ?? {}), screenshot });
    })().catch(() => undefined);
  }

  private handleUnknown(reason: string, snapshot: PageSnapshot, now: number): void {
    this.unknownSince ??= now;
    // First try the obvious fix once: load the poll link afresh.
    if (!this.unknownReloaded && now - this.unknownSince >= this.config.monitor.awayGraceMs) {
      this.unknownReloaded = true;
      this.startRecovery(`the page is showing something unexpected (${reason})`, { planned: true });
      return;
    }
    if (this.unknownReported || now - this.unknownSince < this.config.monitor.unknownAlertMs) return;
    this.unknownReported = true;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const finish = (file: string | null): void => {
      this.logger.warn('page.unknown', {
        reason,
        url: snapshot.url,
        pageText: snapshot.scopeText.slice(0, 300),
        screenshot: file,
        message: `The page is showing something the bot does not recognise (${reason}). If it is a poll, answer it by hand in the bot's window.`,
      });
      this.deps.notify('Poll bot: unrecognised page', `The bot does not recognise what the page is showing (${reason}).`);
    };
    if (this.config.logging.screenshotOnUnknown) {
      void this.monitor.screenshot(this.deps.screenshotDir, `unknown-${stamp}.png`).then(finish, () => finish(null));
    } else {
      finish(null);
    }
  }

  // ------------------------------------------------------------------ polls

  private previousAnswer(fingerprint: string, now: number): AnsweredInfo | null {
    const windowStart = now - this.config.dedupe.windowHours * 60 * 60 * 1000;
    const known = this.answered.get(fingerprint);
    if (known) return known.at >= windowStart ? known : null;
    const stored = this.store.latest(fingerprint, windowStart);
    if (!stored) return null;
    // Seen in an earlier run: nothing has been observed since, so not "separated" yet.
    const info: AnsweredInfo = { at: Date.parse(stored.at), pageShowedAnswered: stored.pageShowedAnswered, separated: false };
    this.answered.set(fingerprint, info);
    return info;
  }

  private remember(poll: Poll, snapshot: PageSnapshot, outcome: 'answered' | 'already_answered', pageShowedAnswered: boolean, response: string | null): void {
    const at = Date.now();
    this.answered.set(poll.fingerprint, { at, pageShowedAnswered, separated: false });
    const redact = this.config.logging.redactQuestionText;
    const saved = this.store.record({
      fingerprint: poll.fingerprint,
      kind: poll.kind,
      at: new Date(at).toISOString(),
      outcome,
      pageShowedAnswered,
      url: locationKey(snapshot.url),
      ...(redact ? {} : { question: poll.question }),
      ...(redact || response === null ? {} : { response }),
    });
    if (!saved && !this.storeWarningGiven) {
      this.storeWarningGiven = true;
      this.logger.error('store.write_failed', {
        file: this.store.file,
        message: `Cannot save the record of answered polls (${this.store.file}). Duplicates are still prevented while the bot keeps running, but not across a restart.`,
      });
    }
  }

  private async handlePoll(recognition: Extract<Recognition, { state: 'poll' }>, snapshot: PageSnapshot, now: number): Promise<void> {
    const { poll, status } = recognition;
    const fingerprint = poll.fingerprint;

    let instance = this.instance;
    if (!instance || instance.fingerprint !== fingerprint) {
      instance = {
        fingerprint,
        poll,
        firstSeenAt: now,
        announced: false,
        openSince: null,
        mountRef: recognition.snapshot.mountRef,
        respondAt: null,
        failedAttempts: 0,
        retryNotBefore: null,
        gaveUpAt: null,
        secondChanceUsed: false,
        countedFailed: false,
        lastStatus: null,
        reported: new Set(),
      };
      this.instance = instance;
    }
    instance.poll = poll;

    // The page rebuilt the poll: earlier responses may not be loaded into it yet,
    // so the settling period starts over.
    if (instance.mountRef !== recognition.snapshot.mountRef) {
      instance.mountRef = recognition.snapshot.mountRef;
      instance.openSince = null;
    }
    if (status === 'open') instance.openSince ??= now;
    else instance.openSince = null;
    instance.lastStatus = status;

    // Announce once it has held still for a moment, so a half-drawn poll is not reported.
    if (!instance.announced) {
      const settle = Math.min(this.config.monitor.settleMs, 300);
      if (now - instance.firstSeenAt < settle) {
        this.waker.request(instance.firstSeenAt + settle);
        return;
      }
      instance.announced = true;
      this.counters.detected += 1;
      const what = poll.kind === 'multiple_choice' ? `${poll.options.length} options` : poll.kind === 'free_text' ? 'free text' : `unsupported: ${poll.unsupportedType ?? 'unknown'}`;
      this.logger.info('poll.detected', {
        fingerprint,
        siteId: poll.siteId,
        kind: poll.kind,
        question: poll.question,
        options: poll.options.map((o) => o.label),
        status,
        message: `New poll: ${quote(poll.question || '(no title)')} (${what})`,
      });
    }

    // Poll Everywhere draws a response the moment it is sent. While the page is still
    // waiting for the server, that drawing proves nothing yet: wait for the outcome.
    if (status === 'answered' && (recognition.snapshot.pendingResponses ?? 0) > 0) {
      this.waker.request(now + 300);
      return;
    }

    const previous = this.previousAnswer(fingerprint, now);
    let doubt = this.doubts.get(fingerprint) ?? null;

    if (status === 'answered') {
      this.settleAnswered(instance, recognition, snapshot, previous, doubt);
      return;
    }

    // An answered poll looking open again raises a doubt: is the response gone, or has
    // the page only lost track of it?
    if (status === 'open' && previous?.pageShowedAnswered && !doubt) {
      doubt = { kind: 'reopened', since: now, checkAfter: now, plan: null };
      this.doubts.set(fingerprint, doubt);
    }

    // One second chance after giving up: if the page has since been loaded afresh (so
    // the network is back) and it still shows the poll open, try again.
    if (
      instance.failedAttempts >= this.config.response.maxAttempts &&
      instance.gaveUpAt !== null &&
      !instance.secondChanceUsed &&
      status === 'open' &&
      snapshot.docStartedAt > instance.gaveUpAt &&
      (snapshot.adapter !== 'pollev' || snapshot.resultsLoaded)
    ) {
      instance.secondChanceUsed = true;
      instance.failedAttempts = 0;
      instance.retryNotBefore = null;
      this.logger.info('poll.second_chance', {
        fingerprint,
        message: 'The page has reloaded and the poll is still open. Trying again.',
      });
    }

    const decision = decide({
      kind: poll.kind,
      status,
      now,
      failedAttempts: instance.failedAttempts,
      maxAttempts: this.config.response.maxAttempts,
      retryNotBefore: instance.retryNotBefore,
      previous,
      unconfirmedAttempt: doubt?.kind === 'unconfirmed',
      reopenSeenAt: doubt?.kind === 'reopened' ? doubt.since : null,
      recheck: this.recheck(snapshot, doubt, now),
      reanswerSettleMs: this.config.dedupe.reanswerSettleMs,
    });

    if (decision.action === 'wait') {
      this.waker.request(decision.until);
      return;
    }

    if (decision.action === 'verify') {
      // A response may already be on the server. Load the page afresh, so that what it
      // shows comes from the server, before sending anything. Not while offline (the
      // load would fail), and never while the page is still sending something.
      if (!snapshot.online || this.monitor.sendingNow(SEND_WAIT_MS)) {
        this.waker.request(now + 500);
        return;
      }
      this.logger.info('poll.server_check', {
        fingerprint,
        reason: decision.reason,
        message:
          decision.reason === 'reopened'
            ? 'A poll already answered looks open again. Reloading the page to check before answering a second time.'
            : 'Checking with the server whether the last attempt went through before trying again.',
      });
      this.startRecovery('checking with the server before sending again', { planned: true });
      return;
    }

    if (decision.action === 'skip') {
      this.reportSkip(instance, poll, decision.reason, recognition.evidence, doubt);
      return;
    }

    // Only during the person's own lecture: the same link may serve another section's.
    // A poll opened before lecture time is answered once lecture time begins.
    if (!this.inLecture()) {
      this.reportOutsideLecture(instance, poll);
      return;
    }
    if (instance.reported.delete('outside_lecture')) this.counters.outsideLecture -= 1;

    // decision.action === 'respond'. Hold off until the response delay has passed and the
    // poll has been steadily open, in the same page element, for the settling period.
    if (instance.respondAt === null) {
      // No extra delay for a poll being answered again (it has already been watched for a
      // while), nor for a competition question, where speed counts.
      const again = decision.reason === 'reopened' || decision.reason === 'reappeared';
      const { min, max } = this.config.response.delayMs;
      instance.respondAt = again || recognition.snapshot.competition ? now : now + randomInt(min, max, this.rng);
    }
    const notBefore = Math.max(instance.respondAt, (instance.openSince ?? now) + this.config.monitor.settleMs);
    if (now < notBefore) {
      this.waker.request(notBefore);
      return;
    }
    // The page is still fetching this participant's earlier responses: it may be about
    // to show the poll as answered. Wait for that, within reason.
    if (this.monitor.resultsLoading(RESULTS_WAIT_MS)) {
      this.waker.request(now + 100);
      return;
    }
    // No network: a response could not get through. Wait for it to come back rather
    // than spend attempts. And never start while an earlier request is still going out.
    if (!snapshot.online || this.monitor.sendingNow(SEND_WAIT_MS)) {
      this.waker.request(now + 500);
      return;
    }

    const plan = chooseResponse(poll, recognition.snapshot, this.config.response, this.rng);
    if (plan.kind === 'skip') {
      if (!instance.reported.has('strategy_skip')) {
        instance.reported.add('strategy_skip');
        this.counters.skipped += 1;
        this.logger.info('poll.skipped', { fingerprint, reason: plan.reason, message: `Not answering: ${plan.reason}.` });
      }
      return;
    }
    if (this.config.dryRun) {
      if (!instance.reported.has('dry_run')) {
        instance.reported.add('dry_run');
        this.counters.skipped += 1;
        this.logger.info('poll.dry_run', {
          fingerprint,
          response: describe(plan),
          message: `Dry run: would answer ${quote(describe(plan))}.`,
        });
      }
      return;
    }

    await this.attempt(instance, poll, plan, snapshot, decision.reason);
  }

  /**
   * The page shows the poll as answered (and is not waiting on the server). That
   * settles any doubt about it, and says whether an unconfirmed attempt got through.
   */
  private settleAnswered(
    instance: Instance,
    recognition: Extract<Recognition, { state: 'poll' }>,
    snapshot: PageSnapshot,
    previous: AnsweredInfo | null,
    doubt: Doubt | null,
  ): void {
    const { poll } = recognition;
    this.doubts.delete(poll.fingerprint);
    const ours = doubt?.kind === 'unconfirmed' && doubt.plan !== null && this.showsResponse(doubt.plan, recognition.snapshot, instance);
    if (doubt?.kind === 'unconfirmed') {
      instance.failedAttempts = 0;
      instance.retryNotBefore = null;
      instance.respondAt = null;
    }
    if (ours && doubt?.plan) {
      // An attempt that was not confirmed at the time did get through after all.
      const response = describe(doubt.plan);
      this.counters.answered += 1;
      this.remember(poll, snapshot, 'answered', true, response);
      this.creditAfterFailure(instance, poll);
      this.logger.info('poll.answered', {
        fingerprint: poll.fingerprint,
        response,
        evidence: recognition.evidence,
        late: true,
        message: `Answered ${quote(response)} — the page now shows it (${recognition.evidence}).`,
      });
    } else if (!previous) {
      this.counters.alreadyAnswered += 1;
      this.remember(poll, snapshot, 'already_answered', true, null);
      this.logger.info('poll.already_answered', {
        fingerprint: poll.fingerprint,
        evidence: recognition.evidence,
        message: `Already answered — leaving it alone (${recognition.evidence}).`,
      });
    } else if (!previous.pageShowedAnswered) {
      previous.pageShowedAnswered = true;
      this.store.markPageShowedAnswered(poll.fingerprint);
    }
    this.setState('WATCHING');
  }

  /** A poll counted as "could not answer" has been answered after all: correct the count, and tell the user. */
  private creditAfterFailure(instance: Instance, poll: Poll): void {
    if (!instance.countedFailed) return;
    instance.countedFailed = false;
    this.counters.failed -= 1;
    this.deps.notify('Poll bot: answered after all', `The bot did answer ${quote(poll.question || 'the poll', 60)} in the end. No need to answer it by hand.`);
  }

  /** Whether the page now shows the response an unconfirmed attempt tried to send. */
  private showsResponse(plan: PlannedResponse, poll: SnapshotPoll, instance: Instance): boolean {
    if (plan.kind === 'choice') {
      const selected = poll.options.filter((o) => o.selected);
      if (selected.length > 0) return selected.some((o) => o.label === plan.label);
      // Marked as answered without showing which option: it is ours unless the user has
      // been told to answer by hand.
      return instance.gaveUpAt === null;
    }
    if (plan.kind === 'text') {
      const wanted = normalizeText(plan.value);
      if (poll.ownResponses.length > 0) return poll.ownResponses.some((r) => normalizeText(r) === wanted);
      return instance.gaveUpAt === null;
    }
    return false;
  }

  /** Where the check with the server stands (see `Recheck`). */
  private recheck(snapshot: PageSnapshot, doubt: Doubt | null, now: number): Recheck {
    if (!doubt || snapshot.docStartedAt <= doubt.checkAfter) return { state: 'unchecked' };
    // Plain pages are drawn by the server, so a fresh load is enough.
    if (snapshot.adapter !== 'pollev') return { state: 'confirmed_open' };
    // Poll Everywhere draws the poll first and fetches earlier responses afterwards;
    // only this document's own successful fetch counts.
    if (snapshot.resultsLoaded) return { state: 'confirmed_open' };
    const until = snapshot.docStartedAt + RESULTS_WAIT_MS;
    return now < until ? { state: 'pending', until } : { state: 'unverifiable' };
  }

  /** Whether polls may be answered now. Always true without lecture times. */
  private inLecture(): boolean {
    const hours = this.deps.lectureHours;
    if (!hours) return true;
    return isLectureTime(hours, (this.deps.clock ?? (() => new Date()))(), this.config.lectureMarginMinutes);
  }

  /** When lecture time next begins, for messages ("Wed 7:55am"), or null. */
  private nextLecture(): string | null {
    const hours = this.deps.lectureHours;
    if (!hours) return null;
    const now = (this.deps.clock ?? (() => new Date()))();
    const next = nextLectureStart(hours, now, this.config.lectureMarginMinutes);
    return next ? describeMoment(next, now) : null;
  }

  /**
   * Says when lecture time begins or ends. The state at start-up is only logged:
   * the start-up lines already said it.
   */
  private noteLectureTime(): void {
    if (!this.deps.lectureHours) return;
    const inLecture = this.inLecture();
    if (inLecture === this.lastInLecture) return;
    const first = this.lastInLecture === null;
    this.lastInLecture = inLecture;
    const next = inLecture ? null : this.nextLecture();
    const when = next ? ` Answering starts ${next}.` : '';
    if (first) {
      this.logger.debug(inLecture ? 'lecture.started' : 'lecture.ended', {
        message: inLecture ? 'It is lecture time: answering polls.' : `It is not lecture time: watching only, no answers.${when}`,
      });
    } else if (inLecture) {
      this.logger.info('lecture.started', { message: 'Lecture time has started: answering polls.' });
    } else {
      this.logger.info('lecture.ended', { message: `Lecture time is over: watching only, no answers.${when}` });
    }
  }

  private reportOutsideLecture(instance: Instance, poll: Poll): void {
    if (instance.reported.has('outside_lecture')) return;
    instance.reported.add('outside_lecture');
    this.counters.outsideLecture += 1;
    const next = this.nextLecture();
    const why =
      instance.failedAttempts > 0
        ? 'your lecture time ended before it could be answered'
        : `it is not lecture time. If it is still open when lecture time starts${next ? ` (${next})` : ''}, it will be answered then`;
    const message = `Not answering ${quote(poll.question || 'this poll', 60)} yet: ${why}. If it is for your lecture now, answer it by hand in the bot's window.`;
    this.logger.info('poll.outside_lecture', { fingerprint: poll.fingerprint, attempted: instance.failedAttempts > 0, message });
    this.deps.notify('Poll bot: not lecture time', message);
  }

  private reportSkip(instance: Instance, poll: Poll, reason: SkipReason, evidence: string, doubt: Doubt | null): void {
    if (instance.reported.has(reason)) return;
    instance.reported.add(reason);
    switch (reason) {
      case 'unsupported': {
        this.counters.unsupported += 1;
        const type = (poll.unsupportedType ?? 'unknown').replace(/_/g, ' ');
        const message = `This activity is a type the bot does not answer (${type}). Answer it by hand in the bot's browser window.`;
        this.logger.warn('poll.unsupported', { fingerprint: poll.fingerprint, type: poll.unsupportedType, question: poll.question, message });
        this.deps.notify('Poll bot: answer this one yourself', message);
        break;
      }
      case 'closed':
        this.logger.info('poll.closed', { fingerprint: poll.fingerprint, evidence, message: `The poll cannot be answered right now (${evidence}).` });
        break;
      case 'duplicate':
      case 'unverifiable': {
        this.counters.skipped += 1;
        let message: string;
        if (reason === 'duplicate') {
          message =
            'A poll the bot already answered is showing as open again, and the page cannot show whether the earlier response still counts. If this is a new vote, answer it by hand.';
        } else if (doubt?.kind === 'unconfirmed') {
          message =
            "The bot's last attempt on this poll may or may not have gone through, and the page did not load your earlier responses to check. Look at the poll in the bot's window and answer it by hand if it still needs a response.";
        } else {
          message =
            'A poll the bot already answered is showing as open again, but the page did not load your earlier responses, so the bot cannot tell whether a new response is wanted. If this is a new vote, answer it by hand.';
        }
        this.logger.warn('poll.duplicate_skipped', { fingerprint: poll.fingerprint, reason, doubt: doubt?.kind ?? null, message });
        this.deps.notify('Poll bot: check this poll', message);
        break;
      }
      case 'gave_up':
      case 'answered_on_page':
        break;
    }
  }

  private async attempt(instance: Instance, poll: Poll, plan: PlannedResponse, snapshot: PageSnapshot, reason: string): Promise<void> {
    this.setState('RESPONDING');
    const attemptNo = instance.failedAttempts + 1;
    const startedAt = Date.now();
    this.logger.info('poll.responding', {
      fingerprint: poll.fingerprint,
      attempt: attemptNo,
      reason,
      response: describe(plan),
    });

    let confirmation: Confirmation;
    try {
      confirmation = await this.submitter.submit(
        poll,
        plan,
        {
          signals: snapshot.signals,
          savedResponses: snapshot.poll?.savedResponses ?? null,
          docStartedAt: snapshot.docStartedAt,
          startedAt,
        },
        this.abort.signal,
      );
    } catch (error) {
      if (error instanceof AbortError) throw error;
      confirmation = { ok: false, evidence: errorMessage(error), pageShowsAnswered: false, pollGone: false, sent: true };
    }
    if (this.abort.signal.aborted) return;

    if (!confirmation.ok && !confirmation.sent && confirmation.pageShowsAnswered) {
      // Nothing was sent because a response turned up on the page first. Not a failure;
      // the next reading records it as already answered.
      this.logger.debug('poll.attempt_not_needed', { fingerprint: poll.fingerprint, evidence: confirmation.evidence });
      this.setState('WATCHING');
      this.waker.wakeNow();
      return;
    }

    if (confirmation.ok) {
      this.doubts.delete(poll.fingerprint);
      this.counters.answered += 1;
      this.remember(poll, snapshot, 'answered', confirmation.pageShowsAnswered, describe(plan));
      this.creditAfterFailure(instance, poll);
      instance.failedAttempts = 0;
      instance.retryNotBefore = null;
      instance.respondAt = null;
      instance.gaveUpAt = null;
      instance.reported.delete('closed');
      this.logger.info('poll.answered', {
        fingerprint: poll.fingerprint,
        response: describe(plan),
        evidence: confirmation.evidence,
        attempt: attemptNo,
        message: `Answered ${quote(describe(plan))} — confirmed (${confirmation.evidence}).`,
      });
      this.setState('WATCHING');
      this.waker.request(Date.now() + this.config.monitor.debounceMs);
      return;
    }

    // Did anything reach the server? Only a reply with an error status is a clear "no";
    // no reply at all, a lost connection, or a request still going out leave it open.
    const sends = this.monitor.sendsSince(startedAt);
    const rejected = sends.total > 0 && sends.rejected === sends.total;
    const uncertain = confirmation.sent && !rejected;
    if (rejected) this.logger.debug('poll.attempt_rejected', { fingerprint: poll.fingerprint, rejected: sends.rejected });

    if (!confirmation.pollGone && (await this.isOffline())) {
      // The network went down during the attempt. That says nothing about the poll,
      // so it does not count; the bot tries again once the network is back (checking
      // with the server first if anything may have been sent).
      if (uncertain) {
        this.doubts.set(poll.fingerprint, { kind: 'unconfirmed', since: Date.now(), checkAfter: Date.now(), plan });
      }
      this.logger.warn('poll.attempt_deferred', {
        fingerprint: poll.fingerprint,
        evidence: confirmation.evidence,
        message: 'The network dropped while answering. Will try again when it is back.',
      });
      this.waker.request(Date.now() + 1000);
      this.setState('WATCHING');
      return;
    }

    instance.failedAttempts += 1;
    const backoff = Math.min(RETRY_CAP_MS, this.config.response.retryDelayMs * 2 ** (instance.failedAttempts - 1));
    // If something may have been sent, give the server at least one more confirmation
    // period before checking with it, so a slow reply is not mistaken for a lost one.
    const wait = uncertain ? Math.max(backoff, this.config.response.confirmTimeoutMs) : backoff;
    instance.retryNotBefore = Date.now() + wait;
    if (uncertain) {
      // Only a page loaded after the wait can tell whether it got through.
      this.doubts.set(poll.fingerprint, { kind: 'unconfirmed', since: Date.now(), checkAfter: instance.retryNotBefore, plan });
    }

    const exhausted = instance.failedAttempts >= this.config.response.maxAttempts || confirmation.pollGone;
    if (exhausted) {
      instance.failedAttempts = this.config.response.maxAttempts;
      instance.gaveUpAt = Date.now();
      if (!instance.countedFailed) {
        instance.countedFailed = true;
        this.counters.failed += 1;
      }
      const message = `Could not answer ${quote(poll.question || '(no title)')}: ${confirmation.evidence}.${confirmation.pollGone ? '' : " If it is still open, answer it by hand in the bot's window."}`;
      this.logger.error('poll.failed', { fingerprint: poll.fingerprint, attempts: attemptNo, evidence: confirmation.evidence, message });
      this.deps.notify('Poll bot: a poll was not answered', message);
    } else {
      this.logger.warn('poll.attempt_failed', {
        fingerprint: poll.fingerprint,
        attempt: attemptNo,
        evidence: confirmation.evidence,
        retryInMs: wait,
        uncertain,
        message: `Attempt ${attemptNo} did not go through (${confirmation.evidence}). Trying again shortly.`,
      });
      this.waker.request(instance.retryNotBefore);
    }
    this.setState('WATCHING');
    this.waker.request(Date.now() + this.config.monitor.debounceMs);
  }

  /** Whether the browser currently reports no network connection. */
  private async isOffline(): Promise<boolean> {
    const result = await this.monitor.snapshot();
    return result.ok && !result.snapshot.online;
  }

  // ------------------------------------------------------------------ keeping the page healthy

  /** True while a response to the poll now showing is still owed, so the page must not be reloaded. */
  private isBusyWith(recognition: Recognition): boolean {
    // Never reload while the page is sending something: that would cut the request off.
    if (this.monitor.sendingNow(SEND_WAIT_MS)) return true;
    if (recognition.state === 'poll' && (recognition.snapshot.pendingResponses ?? 0) > 0) return true;
    const instance = this.instance;
    if (!instance || recognition.state !== 'poll' || recognition.status !== 'open') return false;
    if (recognition.poll.fingerprint !== instance.fingerprint || recognition.poll.kind === 'unsupported') return false;
    return (
      instance.failedAttempts < this.config.response.maxAttempts &&
      !instance.reported.has('duplicate') &&
      !instance.reported.has('unverifiable') &&
      !instance.reported.has('strategy_skip') &&
      !instance.reported.has('dry_run')
    );
  }

  private housekeeping(snapshot: PageSnapshot, recognition: Recognition, busy: boolean, now: number): void {
    if (this.recovery) return;
    const blocked = recognition.state === 'needs_user';

    // Network: note the outage, and reload once it is over to catch anything missed.
    if (!snapshot.online) {
      if (this.offlineSince === null) {
        this.offlineSince = now;
        this.logger.warn('network.offline', { message: 'The network connection dropped. Waiting for it to come back.' });
      }
      return;
    }
    if (this.offlineSince !== null) {
      // Reload to catch up, but not while a request is still going out (try again next pass).
      if (this.monitor.sendingNow(SEND_WAIT_MS)) return;
      const downMs = now - this.offlineSince;
      this.offlineSince = null;
      this.logger.info('network.online', { downMs, message: 'The network is back. Reloading the poll page.' });
      if (!blocked && !this.authPending) this.startRecovery('the network came back');
      return;
    }

    if (blocked) return;

    // The page's push connection. While it is down an activation can be missed, so:
    // a long outage forces a reload, and a dropped connection that comes back is
    // followed by one reload to catch up.
    if (snapshot.pushConnected === false) {
      this.pushDownSince ??= now;
      if (now - this.pushDownSince >= this.config.monitor.pushDownMs && !busy && !this.authPending) {
        this.startRecovery(`the page's live connection has been down for ${Math.round(this.config.monitor.pushDownMs / 1000)} seconds`);
        return;
      }
    } else if (snapshot.pushConnected === true) {
      const dropped = this.pushWasUp && this.pushDownSince !== null;
      this.pushWasUp = true;
      this.pushDownSince = null;
      if (dropped && !busy && !this.authPending) {
        this.startRecovery("the page's live connection was interrupted", { planned: true });
        return;
      }
    }

    // Wandered off the poll page (a link was clicked, a redirect happened, ...).
    if (this.onTarget(snapshot)) {
      this.awaySince = null;
    } else {
      // In the middle of signing in on another site (single sign-on), stay out of the way.
      const onOrigin = sameOrigin(snapshot.url, this.targetUrl);
      const grace = this.authPending ? (onOrigin ? 5000 : Number.POSITIVE_INFINITY) : this.config.monitor.awayGraceMs;
      this.awaySince ??= now;
      if (now - this.awaySince >= grace) {
        const where = locationKey(snapshot.url);
        this.returns.push(now);
        while (this.returns.length > 0 && now - (this.returns[0] ?? now) > 5 * 60 * 1000) this.returns.shift();
        if (this.returns.length >= 3) {
          this.alertUser(
            'leaving',
            'Poll bot: the page keeps leaving the poll link',
            `The poll page keeps sending the browser to ${where}. The bot only works on the link you gave it. Check the bot's browser window; if a poll is showing there, answer it by hand.`,
            { url: where },
          );
        }
        this.startRecovery(`the page is at ${where} instead of the poll link`);
        return;
      }
      if (Number.isFinite(grace)) this.waker.request(this.awaySince + grace);
      return;
    }

    // Periodic reload, in case the page silently stopped receiving updates.
    const resync = this.config.monitor.resyncMs;
    if (resync > 0 && !this.authPending && !busy && now - this.lastNavAt >= resync) {
      this.startRecovery('periodic resync', { planned: true });
    }
  }
}

function describe(plan: PlannedResponse): string {
  if (plan.kind === 'choice') return plan.label;
  if (plan.kind === 'text') return plan.value;
  return `skip: ${plan.reason}`;
}

export function screenshotDirFor(logDir: string): string {
  return path.join(logDir, 'screenshots');
}
