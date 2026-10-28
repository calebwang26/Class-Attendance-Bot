import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type ElementHandle, type Page, type Request } from 'playwright';
import type { Config } from '../config/config.ts';
import type { PageSnapshot } from '../types.ts';
import { errorMessage, withTimeout } from '../util/time.ts';
import { AGENT_GLOBAL, AGENT_VERSION, NOTIFY_BINDING, installPageAgent, type PageAgent } from './pageAgent.ts';

/** The only sites given the computer's location when `browser.shareLocation` is on. */
export const LOCATION_ORIGINS = ['https://pollev.com', 'https://www.pollev.com', 'https://pe.app'] as const;

export interface MonitorEvents {
  /** The page changed in some way; a fresh snapshot is worth taking. */
  onChange(reason: string): void;
  /** The renderer process died. The page object is unusable until replaced. */
  onCrash(): void;
  /** The watched tab or the whole browser was closed by someone other than this program. */
  onClosed(what: 'page' | 'browser'): void;
  /** The page raised an alert/confirm/prompt, which was dismissed. */
  onDialog(type: string, message: string): void;
}

export type SnapshotResult =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; error: string };

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserLaunchError';
  }
}

interface AgentWindow {
  [AGENT_GLOBAL]?: PageAgent;
}

/**
 * Owns the browser: one persistent Chromium profile and one watched tab.
 * Injects the page agent into every document, relays its change
 * notifications, and gives the rest of the program two things only: a
 * snapshot of the page and a handle to an element the snapshot named.
 */
export class BrowserMonitor {
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private launching: Promise<BrowserContext> | null = null;
  /** Requests in flight that load a participant's earlier responses, with their start times. */
  private readonly resultLoads = new Map<Request, number>();
  /** Requests in flight that send something (anything but GET/HEAD/OPTIONS), with their start times. */
  private readonly writes = new Map<Request, number>();
  /** How recent sending requests ended: HTTP status, or null for a network failure. */
  private readonly writeLog: { start: number; end: number; status: number | null; path: string }[] = [];
  private readonly config: Config;
  private readonly profileDir: string;
  private readonly events: MonitorEvents;

  constructor(config: Config, profileDir: string, events: MonitorEvents) {
    this.config = config;
    this.profileDir = profileDir;
    this.events = events;
  }

  get page(): Page | null {
    return this.currentPage;
  }

  get isOpen(): boolean {
    return this.context !== null && !this.closing;
  }

  /** Launches the browser with the bot's own profile and opens a blank tab. */
  async launch(): Promise<void> {
    fs.mkdirSync(this.profileDir, { recursive: true });
    const headless = this.config.browser.headless;
    let context: BrowserContext;
    try {
      this.launching = chromium.launchPersistentContext(this.profileDir, {
        headless,
        ...(this.config.browser.channel ? { channel: this.config.browser.channel } : {}),
        // A real window sizes the page itself; headless needs an explicit size.
        viewport: headless ? { width: 1280, height: 800 } : null,
        timeout: 60000,
        // The bot handles Ctrl+C and shutdown itself. Playwright's own handler would end
        // the process before the bot could close the browser and print its summary.
        // (Playwright still kills the browser if this process exits unexpectedly.)
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(this.config.browser.extensions ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      });
      context = await this.launching;
    } catch (error) {
      const text = String(error);
      if (/ProcessSingleton|SingletonLock|profile.*(in use|already)|user data directory is already in use/i.test(text)) {
        throw new BrowserLaunchError(
          "The bot's browser profile is already in use. Another copy of the bot (or its browser window) is still open — close it and try again.",
        );
      }
      if (/Executable doesn't exist|playwright install|browserType\.launch.*not found/i.test(text)) {
        throw new BrowserLaunchError(
          this.config.browser.channel
            ? `Could not start the "${this.config.browser.channel}" browser. Is it installed?`
            : 'The browser the bot uses is not installed yet. Run:  npx playwright install chromium',
        );
      }
      throw new BrowserLaunchError(`Could not start the browser: ${errorMessage(error)}`);
    } finally {
      this.launching = null;
    }
    if (this.closing) {
      // Stopped while the browser was starting: shut it down again.
      await context.close().catch(() => undefined);
      throw new BrowserLaunchError('stopped while the browser was starting');
    }
    this.context = context;
    await context.exposeBinding(NOTIFY_BINDING, (source, reason: unknown) => {
      if (source.page !== this.currentPage) return;
      if (source.frame !== source.page.mainFrame()) return;
      if (!this.config.monitor.eventDriven) return;
      this.events.onChange(typeof reason === 'string' ? reason : 'mutation');
    });
    if (this.config.browser.shareLocation) {
      // The real location from the operating system: no position is ever set by the bot.
      for (const origin of LOCATION_ORIGINS) await context.grantPermissions(['geolocation'], { origin });
    }
    await context.addInitScript(installPageAgent, this.agentOptions());
    context.on('close', () => {
      if (this.closing) return;
      this.context = null;
      this.currentPage = null;
      this.events.onClosed('browser');
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.adopt(page);
  }

  private agentOptions(): { quietMs: number } {
    return { quietMs: Math.max(10, Math.min(100, Math.floor(this.config.monitor.debounceMs / 2))) };
  }

  private adopt(page: Page): void {
    this.currentPage = page;
    page.on('close', () => {
      if (this.closing || page !== this.currentPage) return;
      this.currentPage = null;
      this.events.onClosed('page');
    });
    page.on('crash', () => {
      if (page === this.currentPage) this.events.onCrash();
    });
    page.on('framenavigated', (frame) => {
      // Also raised for in-page address changes (history API), so it only prompts a read.
      if (page === this.currentPage && frame === page.mainFrame()) this.events.onChange('navigated');
    });
    page.on('domcontentloaded', () => {
      // A new document: raised once per real page load.
      if (page === this.currentPage) this.events.onChange('loaded');
    });
    page.on('load', () => {
      if (page === this.currentPage) this.events.onChange('load');
    });
    // Track two kinds of requests the page makes. A page that has just drawn a poll
    // fetches the participant's earlier responses; until that arrives the poll looks
    // unanswered. And a response being sent must never be cut off by a reload.
    // Requests of a document that is replaced end as failed, so nothing goes stale.
    page.on('request', (request) => {
      if (page !== this.currentPage) return;
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      const method = request.method();
      if (method === 'GET') {
        if (type === 'document') return;
        try {
          if (/\/results\/?$/.test(new URL(request.url()).pathname)) this.resultLoads.set(request, Date.now());
        } catch {
          // Not a URL worth tracking.
        }
      } else if (method !== 'HEAD' && method !== 'OPTIONS' && sameSite(request.url(), page.url())) {
        // Only the poll site's own requests: analytics and error reports sent to other
        // sites are not responses, and must not hold anything up.
        this.writes.set(request, Date.now());
      }
    });
    const ended = (request: Request, status: number | null): void => {
      this.resultLoads.delete(request);
      const start = this.writes.get(request);
      if (start === undefined) return;
      this.writes.delete(request);
      let where = '';
      try {
        where = new URL(request.url()).pathname;
      } catch {
        // Keep the empty path.
      }
      this.writeLog.push({ start, end: Date.now(), status, path: where });
      if (this.writeLog.length > 50) this.writeLog.splice(0, this.writeLog.length - 50);
    };
    // A request that sent something counts as answered once the reply's status arrives.
    // ("Finished" would also need the reply's body, which a page may never read.)
    page.on('response', (response) => {
      const request = response.request();
      if (this.writes.has(request)) ended(request, response.status());
    });
    page.on('requestfinished', (request) => {
      this.resultLoads.delete(request);
    });
    page.on('requestfailed', (request) => ended(request, null));
    page.on('dialog', (dialog) => {
      // An open dialog freezes the page. Leave-page prompts are accepted so reloads work;
      // anything else is dismissed, which is the non-committal answer.
      const type = dialog.type();
      const message = dialog.message();
      const settle = type === 'beforeunload' ? dialog.accept() : dialog.dismiss();
      settle.catch(() => undefined);
      if (page === this.currentPage) this.events.onDialog(type, message);
    });
  }

  /**
   * True while the page is fetching a participant's earlier responses. A request
   * older than `giveUpAfterMs` is ignored so a stuck one cannot block forever.
   */
  resultsLoading(giveUpAfterMs: number): boolean {
    const now = Date.now();
    for (const startedAt of this.resultLoads.values()) {
      if (now - startedAt < giveUpAfterMs) return true;
    }
    return false;
  }

  /**
   * True while the page is sending something (a response, typically). Reloading
   * then would cut the request off without telling whether it arrived. A request
   * older than `giveUpAfterMs` is ignored so a stuck one cannot block forever.
   */
  sendingNow(giveUpAfterMs: number): boolean {
    const now = Date.now();
    for (const startedAt of this.writes.values()) {
      if (now - startedAt < giveUpAfterMs) return true;
    }
    return false;
  }

  /**
   * How the requests that sent something since `since` (epoch ms) ended. A
   * request still in flight counts as `inFlight`; one that got no reply as
   * `networkFailures`; one answered with an HTTP status 400 or above as `rejected`.
   * `acceptedPaths` lists the address paths of the accepted ones.
   */
  sendsSince(since: number): {
    total: number;
    inFlight: number;
    networkFailures: number;
    rejected: number;
    accepted: number;
    acceptedPaths: string[];
  } {
    const result = { total: 0, inFlight: 0, networkFailures: 0, rejected: 0, accepted: 0, acceptedPaths: [] as string[] };
    for (const startedAt of this.writes.values()) {
      if (startedAt >= since) {
        result.total += 1;
        result.inFlight += 1;
      }
    }
    for (const entry of this.writeLog) {
      if (entry.start < since) continue;
      result.total += 1;
      if (entry.status === null) result.networkFailures += 1;
      else if (entry.status >= 400) result.rejected += 1;
      else {
        result.accepted += 1;
        result.acceptedPaths.push(entry.path);
      }
    }
    return result;
  }

  /** Loads `url` in the watched tab. Throws on network errors and timeouts. */
  async navigate(url: string): Promise<void> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.monitor.navigationTimeoutMs });
  }

  async reload(): Promise<void> {
    const page = this.requirePage();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.monitor.navigationTimeoutMs });
  }

  /** Replaces a crashed or closed tab with a fresh one in the same profile. */
  async replacePage(): Promise<void> {
    if (!this.context) throw new Error('the browser is not running');
    const old = this.currentPage;
    const fresh = await withTimeout(this.context.newPage(), this.config.monitor.navigationTimeoutMs, 'opening a new tab');
    this.resultLoads.clear();
    this.writes.clear();
    this.adopt(fresh);
    if (old && old !== fresh && !old.isClosed()) {
      await withTimeout(old.close({ runBeforeUnload: false }), 10000, 'closing the old tab').catch(() => undefined);
    }
  }

  /** Reads the current state of the page. Never throws. */
  async snapshot(): Promise<SnapshotResult> {
    const page = this.currentPage;
    if (!page || page.isClosed()) return { ok: false, error: 'no page' };
    const read = async (): Promise<PageSnapshot | null> =>
      page.evaluate(
        ({ key, version }) => {
          const agent = (window as unknown as Record<string, { version: number; snapshot(): unknown } | undefined>)[key];
          if (!agent || agent.version !== version) return null;
          return agent.snapshot();
        },
        { key: AGENT_GLOBAL, version: AGENT_VERSION },
      ) as Promise<PageSnapshot | null>;
    try {
      const timeout = this.config.monitor.snapshotTimeoutMs;
      let snapshot = await withTimeout(read(), timeout, 'reading the page');
      if (snapshot === null) {
        // The agent is missing (a document that predates it). Install it and read again.
        await withTimeout(page.evaluate(installPageAgent, this.agentOptions()), timeout, 'installing the page agent');
        snapshot = await withTimeout(read(), timeout, 'reading the page');
      }
      if (snapshot === null) return { ok: false, error: 'page agent unavailable' };
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** The element a snapshot referred to by `ref`, or null if it is no longer in the page. */
  async resolve(ref: string): Promise<ElementHandle<HTMLElement> | null> {
    const page = this.currentPage;
    if (!page || page.isClosed()) return null;
    try {
      const handle = await withTimeout(page.evaluateHandle(
        ({ key, ref: r }) => {
          const agent = (window as unknown as AgentWindow & Record<string, PageAgent | undefined>)[key];
          const element = agent ? agent.resolve(r) : null;
          return element && element.isConnected ? element : null;
        },
        { key: AGENT_GLOBAL, ref },
      ), this.config.monitor.snapshotTimeoutMs, 'finding the element');
      const element = handle.asElement();
      if (!element) {
        await handle.dispose().catch(() => undefined);
        return null;
      }
      return element as ElementHandle<HTMLElement>;
    } catch {
      return null;
    }
  }

  /** The visible blocking dialog's text, buttons and markup, or null if none can be read. */
  async describeDialog(): Promise<{ text: string; buttons: string[]; html: string } | null> {
    const page = this.currentPage;
    if (!page || page.isClosed()) return null;
    try {
      return await withTimeout(
        page.evaluate(() => {
          const visible = (el: Element): boolean => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          const dialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]')).find(visible);
          if (!dialog) return null;
          const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
          const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], a[href], input[type="submit"], input[type="button"]'))
            .filter(visible)
            .map((b) => squash(b.textContent) || squash(b.getAttribute('aria-label')) || squash((b as HTMLInputElement).value) || '(no label)');
          return { text: squash((dialog as HTMLElement).innerText).slice(0, 1000), buttons, html: dialog.outerHTML.slice(0, 20000) };
        }),
        this.config.monitor.snapshotTimeoutMs,
        'reading the dialog',
      );
    } catch {
      return null;
    }
  }

  /** Saves a screenshot. Returns the file path, or null if it could not be taken. */
  async screenshot(dir: string, name: string): Promise<string | null> {
    const page = this.currentPage;
    if (!page || page.isClosed()) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      await page.screenshot({ path: file, timeout: 10000 });
      return file;
    } catch {
      return null;
    }
  }

  private requirePage(): Page {
    const page = this.currentPage;
    if (!page || page.isClosed()) throw new Error('the page is closed');
    return page;
  }

  /**
   * Closes the browser and resolves once it has shut down cleanly, so the
   * profile (and a fresh sign-in) is saved. Safe to call more than once: every
   * call waits for the same shutdown.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closing = true;
      const context = this.context;
      const launching = this.launching;
      this.context = null;
      this.currentPage = null;
      this.closed = (async () => {
        if (context) await context.close().catch(() => undefined);
        // A launch still in progress closes its own browser when it notices `closing`.
        else if (launching) await launching.then((c) => c.close(), () => undefined).catch(() => undefined);
      })();
    }
    return this.closed;
  }
}
