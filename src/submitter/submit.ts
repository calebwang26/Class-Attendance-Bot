import type { ElementHandle } from 'playwright';
import type { BrowserMonitor } from '../browser/monitor.ts';
import type { Config } from '../config/config.ts';
import type { Logger } from '../logger/logger.ts';
import { recognize, type RecognizeOptions } from '../recognizer/recognize.ts';
import type { Confirmation, PageSignals, PageSnapshot, PlannedResponse, Poll, Recognition } from '../types.ts';
import { errorMessage, sleep, withTimeout } from '../util/time.ts';

/** The page's own counters as they stood just before an attempt. */
export interface Baseline {
  signals: PageSignals;
  savedResponses: number | null;
  /** Which document the counters belong to (they start again at zero on a reload). */
  docStartedAt: number;
  /** When the attempt began (epoch ms); requests the page sends from then on are this attempt's. */
  startedAt: number;
}

/** How often the page is re-read while waiting for it. */
const POLL_MS = 150;
/** How long a momentary redraw or unreadable page is waited out during an attempt. */
const TRANSIENT_MS = 2500;
/** How long the page must show something else before the poll counts as gone. */
const GONE_MS = 1000;
/** Poll Everywhere 2.0: how long, after the server accepted a response, the page may take to show it. */
const SHOW_MS = 1500;
/** Poll Everywhere 2.0: the address a response is sent to (/a/questions/<id>/responses[/<choice>]). */
const RESPONSE_PATH = /\/questions\/[^/]+\/responses(?:\/|$)/;

type Activation = 'click' | 'keyboard' | 'dom_click' | 'none';

interface Reading {
  snapshot: PageSnapshot;
  recognition: Recognition;
}

type PollReading = Extract<Recognition, { state: 'poll' }>;

/** Nothing was sent. */
function fail(evidence: string, options: { pollGone?: boolean } = {}): Confirmation {
  return { ok: false, evidence, pageShowsAnswered: false, pollGone: options.pollGone === true, sent: false };
}

/** A control was operated but the response was not confirmed. */
function sentButFailed(evidence: string, pollGone = false): Confirmation {
  return { ok: false, evidence, pageShowsAnswered: false, pollGone, sent: true };
}

/** Nothing was sent, because the page already shows a response. */
function alreadyThere(current: PollReading): Confirmation {
  return { ok: false, evidence: `nothing was sent: ${current.evidence}`, pageShowsAnswered: true, pollGone: false, sent: false };
}

/**
 * Performs one response attempt through the page's own controls and waits for
 * the page to show that it was accepted. It never retries by itself and never
 * acts without first re-reading the page; retry policy belongs to the caller.
 */
export class Submitter {
  private readonly monitor: BrowserMonitor;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly recognizeOptions: RecognizeOptions;

  constructor(monitor: BrowserMonitor, config: Config, logger: Logger, recognizeOptions: RecognizeOptions) {
    this.monitor = monitor;
    this.config = config;
    this.logger = logger;
    this.recognizeOptions = recognizeOptions;
  }

  async submit(poll: Poll, plan: PlannedResponse, before: Baseline, signal: AbortSignal): Promise<Confirmation> {
    if (plan.kind === 'skip') return fail(`skipped: ${plan.reason}`);
    if (plan.kind === 'choice') return this.submitChoice(poll, plan, before, signal);
    return this.submitText(poll, plan, before, signal);
  }

  private get actionTimeoutMs(): number {
    return Math.max(500, Math.min(5000, Math.floor(this.config.response.confirmTimeoutMs / 2)));
  }

  private async read(): Promise<Reading | null> {
    const result = await this.monitor.snapshot();
    if (!result.ok) return null;
    return { snapshot: result.snapshot, recognition: recognize(result.snapshot, this.recognizeOptions) };
  }

  /** The reading, if it shows this poll. */
  private samePoll(reading: Reading | null, poll: Poll): PollReading | null {
    if (!reading || reading.recognition.state !== 'poll') return null;
    return reading.recognition.poll.fingerprint === poll.fingerprint ? reading.recognition : null;
  }

  /**
   * Reads the page until it shows this poll. A momentary redraw, a page that
   * cannot be read for a moment, or a loading state is waited out; only a
   * different poll or the waiting screen, held for a second, means the poll
   * is gone.
   */
  private async waitForPoll(poll: Poll, signal: AbortSignal): Promise<{ current: PollReading | null; gone: boolean }> {
    const deadline = Date.now() + TRANSIENT_MS;
    let otherSince: number | null = null;
    for (;;) {
      const reading = await this.read();
      const current = this.samePoll(reading, poll);
      if (current) return { current, gone: false };
      const now = Date.now();
      const showing = reading?.recognition.state;
      if (showing === 'poll' || showing === 'waiting') {
        otherSince ??= now;
        if (now - otherSince >= GONE_MS) return { current: null, gone: true };
      } else {
        otherSince = null;
      }
      if (now >= deadline || signal.aborted) return { current: null, gone: false };
      await sleep(POLL_MS, signal).catch(() => undefined);
    }
  }

  private async submitChoice(
    poll: Poll,
    plan: Extract<PlannedResponse, { kind: 'choice' }>,
    before: Baseline,
    signal: AbortSignal,
  ): Promise<Confirmation> {
    const handle = await this.monitor.resolve(plan.ref);
    if (!handle) return fail('the chosen option is no longer on the page');
    const method = await this.activate(handle, poll, signal);
    this.logger.debug('submit.activated', { method, kind: 'choice' });
    if (method === 'none') {
      // Nothing was operated: the page moved on, or the control could not be used.
      const { current, gone } = await this.waitForPoll(poll, signal);
      if (gone) return fail('the poll went away before it could be answered', { pollGone: true });
      if (current?.status === 'answered') return alreadyThere(current);
      return fail('the option could not be selected');
    }
    return this.confirm(poll, before, signal, { submitClicked: false });
  }

  private async submitText(
    poll: Poll,
    plan: Extract<PlannedResponse, { kind: 'text' }>,
    before: Baseline,
    signal: AbortSignal,
  ): Promise<Confirmation> {
    const start = await this.waitForPoll(poll, signal);
    if (start.gone) return fail('the poll went away before it could be answered', { pollGone: true });
    const first = start.current;
    if (!first) return fail('the page could not be read');
    if (first.status === 'answered') return alreadyThere(first);
    if (!first.snapshot.textInput) return fail('the text box is no longer on the page');
    const box = await this.monitor.resolve(first.snapshot.textInput.ref);
    if (!box) return fail('the text box is no longer on the page');

    try {
      // fill() focuses the box and raises the same input events as typing.
      await box.fill(plan.value, { timeout: this.actionTimeoutMs });
    } catch (error) {
      return fail(`could not type into the text box: ${errorMessage(error)}`);
    }
    if (signal.aborted) return fail('stopped');

    // Typing is what enables the submit control, so look at the page again.
    const after = await this.waitForPoll(poll, signal);
    if (after.gone) return fail('the poll went away while typing', { pollGone: true });
    const typed = after.current;
    if (!typed) return fail('the page could not be read after typing');
    if (typed.snapshot.textInput?.ref !== first.snapshot.textInput.ref) {
      return fail('the poll was redrawn while typing');
    }
    const submit = typed.snapshot.submit;
    let method: Activation = 'none';
    if (submit && !submit.disabled) {
      const control = await this.monitor.resolve(submit.ref);
      if (control) method = await this.activate(control, poll, signal);
    }
    if (method === 'none') {
      // No usable submit control: Enter in the box is the other normal way to send.
      // Only if the poll is still waiting for a response; never on top of one already there.
      const again = await this.waitForPoll(poll, signal);
      if (again.gone) return fail('the poll went away while typing', { pollGone: true });
      if (!again.current) return fail('the page could not be read after typing');
      if (again.current.status === 'answered') return alreadyThere(again.current);
      if (again.current.status !== 'open') return fail(`nothing was sent: ${again.current.evidence}`);
      try {
        await box.press('Enter', { timeout: this.actionTimeoutMs });
        method = 'keyboard';
      } catch (error) {
        return fail(`could not submit the text: ${errorMessage(error)}`);
      }
    }
    this.logger.debug('submit.activated', { method, kind: 'text' });
    return this.confirm(poll, before, signal, { submitClicked: true, textSent: true });
  }

  /**
   * Operates a control the way a person would, most direct method first:
   * a real mouse click; if something covers the control, the keyboard; and
   * as a last resort the element's own click(). Before each fallback the page
   * is re-read, and nothing further is done unless the poll is still open.
   */
  private async activate(handle: ElementHandle<HTMLElement>, poll: Poll, signal: AbortSignal): Promise<Activation> {
    const stillOpen = async (): Promise<boolean> => {
      if (signal.aborted) return false;
      const { current } = await this.waitForPoll(poll, signal);
      return current !== null && current.status === 'open';
    };
    const timeout = this.actionTimeoutMs;

    try {
      await handle.click({ timeout });
      return 'click';
    } catch (error) {
      this.logger.debug('submit.click_failed', { error: errorMessage(error) });
    }
    if (!(await stillOpen())) return 'none';

    try {
      const info = await withTimeout(
        handle.evaluate((el) => {
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          const focusable = tag === 'button' || tag === 'input' || tag === 'a' || el.tabIndex >= 0;
          if (focusable) el.focus();
          const disabled = (el as HTMLButtonElement).disabled === true;
          return { tag, type, focused: document.activeElement === el, disabled };
        }),
        timeout,
        'focusing the control',
      );
      const page = this.monitor.page;
      if (info.focused && !info.disabled && page) {
        const key = info.tag === 'input' && (info.type === 'radio' || info.type === 'checkbox') ? 'Space' : 'Enter';
        await withTimeout(page.keyboard.press(key), timeout, 'pressing a key');
        return 'keyboard';
      }
    } catch (error) {
      this.logger.debug('submit.keyboard_failed', { error: errorMessage(error) });
    }
    if (!(await stillOpen())) return 'none';

    try {
      const clicked = await withTimeout(
        handle.evaluate((el) => {
          if (!el.isConnected || (el as HTMLButtonElement).disabled === true) return false;
          el.click();
          return true;
        }),
        timeout,
        'clicking the control',
      );
      return clicked ? 'dom_click' : 'none';
    } catch (error) {
      this.logger.debug('submit.dom_click_failed', { error: errorMessage(error) });
      return 'none';
    }
  }

  /**
   * How long an "answered" display must hold when the page gave no explicit
   * saved signal. Poll Everywhere draws a response as recorded before the
   * server has accepted it and then announces the save, so there the display
   * alone only counts once the whole confirmation time has passed without an
   * error, and only if the page is no longer waiting for the server.
   * Elsewhere the display normally follows the server's reply.
   */
  private settleFor(snapshot: PageSnapshot): number {
    const timeout = this.config.response.confirmTimeoutMs;
    return snapshot.adapter !== 'generic' ? Math.max(0, timeout - 400) : Math.min(1000, Math.floor(timeout / 4));
  }

  /**
   * Waits for the page to show the response was accepted. Evidence, strongest first:
   *
   *   1. the page's own "saved" announcement, raised only after the server accepted;
   *   2. the page's own record of responses gaining a saved entry;
   *   3. on Poll Everywhere 2.0, the server accepting the vote's request and the
   *      page then showing the vote;
   *   4. the poll displaying as answered and staying that way, with nothing
   *      left waiting for the server.
   *
   * An error raised by the page since the attempt began means failure. On pages
   * where choosing an option does not send it, the submit control is operated once.
   */
  private async confirm(
    poll: Poll,
    before: Baseline,
    signal: AbortSignal,
    flags: { submitClicked: boolean; textSent?: boolean },
  ): Promise<Confirmation> {
    const timeout = this.config.response.confirmTimeoutMs;
    const deadline = Date.now() + timeout;
    const shortSettle = Math.min(1000, Math.floor(timeout / 4));
    let answeredSince: number | null = null;
    let clearedSince: number | null = null;
    let goneSince: number | null = null;
    let submitClicked = flags.submitClicked;
    let stillPending = false;
    let acceptedSince: number | null = null;

    while (Date.now() < deadline) {
      if (signal.aborted) return sentButFailed('stopped');
      const reading = await this.read();
      const now = Date.now();
      const current = this.samePoll(reading, poll);
      const shown = current ? `; ${current.evidence}` : '';
      const pageShowsAnswered = current?.status === 'answered';
      // The page's counters restart on a reload, so they only count on the same document.
      const sameDocument = reading !== null && reading.snapshot.docStartedAt === before.docStartedAt;

      if (sameDocument && reading.snapshot.signals.saved > before.signals.saved) {
        return { ok: true, evidence: `the page announced the response was saved${shown}`, pageShowsAnswered, pollGone: false, sent: true };
      }
      if (
        sameDocument &&
        current &&
        before.savedResponses !== null &&
        current.snapshot.savedResponses !== null &&
        current.snapshot.savedResponses > before.savedResponses
      ) {
        return { ok: true, evidence: `the page's record of your responses shows it saved${shown}`, pageShowsAnswered, pollGone: false, sent: true };
      }
      if (sameDocument && reading.snapshot.signals.errors > before.signals.errors) {
        return sentButFailed(`the page reported an error: ${reading.snapshot.signals.lastError ?? 'unknown error'}`, current === null);
      }
      if (reading?.snapshot.adapter === 'pollev2') {
        // This page sends a response as an ordinary form request to the question's
        // ".../responses" address, and the reply's status says whether it was taken.
        const sends = this.monitor.sendsSince(before.startedAt);
        if (sends.total > 0 && sends.inFlight === 0 && sends.rejected === sends.total) {
          return sentButFailed('the server refused the response', current === null);
        }
        if (sends.inFlight === 0 && sends.acceptedPaths.some((p) => RESPONSE_PATH.test(p))) {
          acceptedSince ??= now;
          // Give the page a moment to draw the response, so it is known whether it can.
          if (current?.status === 'answered' || now - acceptedSince >= SHOW_MS) {
            const shows = current?.status === 'answered';
            return {
              ok: true,
              evidence: shows ? `the server accepted the response and ${current.evidence}` : 'the server accepted the response',
              pageShowsAnswered: shows,
              pollGone: false,
              sent: true,
            };
          }
        }
      }

      if (!current) {
        answeredSince = null;
        clearedSince = null;
        stillPending = false;
        // A different poll or the waiting screen (not a momentary redraw) means it is gone.
        const showing = reading?.recognition.state;
        if (showing === 'poll' || showing === 'waiting') {
          goneSince ??= now;
          if (now - goneSince >= GONE_MS) return sentButFailed('the poll went away before the response was confirmed', true);
        } else {
          goneSince = null;
        }
      } else {
        goneSince = null;
        if (current.status === 'answered') {
          answeredSince ??= now;
          stillPending = (current.snapshot.pendingResponses ?? 0) > 0;
          if (reading && !stillPending && now - answeredSince >= this.settleFor(reading.snapshot)) {
            return { ok: true, evidence: `${current.evidence}, and it stayed that way`, pageShowsAnswered: true, pollGone: false, sent: true };
          }
        } else {
          answeredSince = null;
          stillPending = false;
          if (current.status === 'open' && !submitClicked && current.snapshot.submit && !current.snapshot.submit.disabled) {
            // The choice is made but not sent: this page has a separate submit step.
            if (current.poll.options.some((o) => o.selected)) {
              submitClicked = true;
              const control = await this.monitor.resolve(current.snapshot.submit.ref);
              if (control) await this.activate(control, poll, signal);
              continue;
            }
          }
          // Free text on a page that lists no responses: an emptied box is the only trace.
          // Not used for Poll Everywhere, which always lists them.
          if (
            flags.textSent &&
            reading?.snapshot.adapter === 'generic' &&
            current.snapshot.textInput &&
            current.snapshot.textInput.value === ''
          ) {
            clearedSince ??= now;
          } else {
            clearedSince = null;
          }
        }
      }
      await sleep(POLL_MS, signal).catch(() => undefined);
    }

    if (clearedSince !== null && Date.now() - clearedSince >= shortSettle) {
      return {
        ok: true,
        evidence: 'the text box was emptied after submitting and no error appeared (the page does not list responses)',
        pageShowsAnswered: false,
        pollGone: false,
        sent: true,
      };
    }
    if (stillPending) return sentButFailed(`the server had not answered within ${timeout} ms`);
    return sentButFailed(`the page did not confirm the response within ${timeout} ms`, goneSince !== null);
  }
}
