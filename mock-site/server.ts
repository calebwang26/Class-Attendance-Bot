import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * A local stand-in for a live polling site, used by the tests and for trying
 * the bot by hand. It is bound to 127.0.0.1 only.
 *
 * The participant page at /pollev/<presenter> reproduces the structure and
 * behaviour of the real Poll Everywhere participant page as established from
 * that site's own scripts (see docs/TECHNICAL_DESIGN.md): the same element
 * and class names, the same status texts, optimistic updates, the "result"
 * and "notification:show" events, and the brief window after a poll is drawn
 * in which earlier responses have not been loaded yet.
 *
 * /generic/<room> is a plain HTML form page with radio buttons or a text box,
 * for the generic extractor.
 */

export type ActivityType =
  | 'multiple_choice_poll'
  | 'free_text_poll'
  | 'ranking_poll'
  | 'clickable_image'
  | 'discourse'
  | 'survey'
  | 'competition';

export interface PollSpec {
  type?: ActivityType;
  title: string;
  options?: string[];
  /** Responses allowed per participant. null = unlimited. Default 1. */
  maxVotes?: number | null;
  /** Times each option may be chosen by one participant. */
  responsesPerOption?: number | null;
  editableAnswers?: boolean;
  /** "maxed_out" is a poll that has received all the responses it allows ("Poll is full"). */
  state?: 'opened' | 'closed' | 'maxed_out';
  /** The presenter hides the title from participants. */
  titleHidden?: boolean;
  /** The poll's permanent id. Generated when omitted. */
  id?: string;
  /** Competition only: which screen the competition is on. */
  displayState?: 'welcome' | 'instructions' | 'leaderboard';
}

export interface PollRecord {
  id: string;
  type: ActivityType;
  title: string;
  options: { id: string; value: string }[];
  maxVotes: number | null;
  responsesPerOption: number | null;
  editableAnswers: boolean;
  state: 'opened' | 'closed' | 'maxed_out';
  titleHidden: boolean;
  webEnabled: boolean;
  displayState: string | null;
  /** Bumped whenever responses are cleared. */
  round: number;
}

export interface LedgerEntry {
  id: string;
  pollId: string;
  round: number;
  participant: string;
  optionId: string | null;
  /** Option label for multiple choice, the text for free text. */
  value: string;
  at: string;
  source: 'pollev' | 'generic';
}

export interface SubmitAttempt {
  pollId: string;
  participant: string;
  at: string;
  outcome: 'accepted' | 'rejected' | 'failed';
  detail: string;
}

export interface Faults {
  /** Fail this many upcoming submissions with HTTP 500. */
  failSubmits: number;
  /** Delay every submission response by this long. */
  submitDelayMs: number;
  /** Delay the response that restores a participant's earlier responses. */
  resultsDelayMs: number;
  /** Draw only the poll header first; add the controls this much later. */
  skeletonMs: number;
  /** Insert the poll's mount element this long before anything is drawn in it. */
  mountDelayMs: number;
  /** Keep connections open but stop sending activations (a silently dead push channel). */
  pushSilent: boolean;
  /** Close push connections and refuse new ones. */
  pushDown: boolean;
  /** On a new activation, reuse the existing mount element instead of replacing it. */
  reuseMount: boolean;
  /** The page never fetches a participant's earlier responses (as when a poll is drawn before it has an id). */
  noRestore: boolean;
  /** Fetching a participant's earlier responses fails with HTTP 500. */
  failResults: boolean;
  /** Leave the response count out of what the page is given (the real page then ignores "responses cleared" for multiple choice). */
  omitResultsCount: boolean;
  /** Reject and fail submissions with a JSON body that lacks the usual "error" key (the real page then raises no error event). */
  errorWithoutKey: boolean;
  /** Show options as equations still loading ("[loading eqn.]") for this long. */
  equationMs: number;
  /** Record this many upcoming submissions, then drop the connection without replying (a lost reply). */
  dropReplies: number;
  /** On page load, show the waiting screen this long before drawing an active poll. */
  waitingFlashMs: number;
  /** This long after drawing a poll, change the page address in place (history API). */
  pushStateMs: number;
  /**
   * Do not replay pushes a page missed between being rendered and connecting.
   * (The real page asks its push service for that history; whether the service
   * honours it is not known.)
   */
  noReplay: boolean;
}

export interface PageFlags {
  signedIn: boolean;
  cookieBanner: boolean;
  /** Cover the whole page with an element that swallows mouse clicks. */
  overlay: boolean;
  screenNameDialog: boolean;
  /** Show the live / pinned tab buttons above the activity. */
  tabs: boolean;
  /** Generic page: say nothing after a free-text submission. */
  genericSilent: boolean;
  /** Show controls of a kind the bot has never seen in place of the waiting screen. */
  unknownWidget: boolean;
}

interface Client {
  res: http.ServerResponse;
  channel: string;
}

const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export class MockSite {
  readonly faults: Faults = {
    failSubmits: 0,
    submitDelayMs: 0,
    resultsDelayMs: 0,
    skeletonMs: 0,
    mountDelayMs: 0,
    pushSilent: false,
    pushDown: false,
    reuseMount: false,
    noRestore: false,
    failResults: false,
    omitResultsCount: false,
    errorWithoutKey: false,
    equationMs: 0,
    dropReplies: 0,
    noReplay: false,
    waitingFlashMs: 0,
    pushStateMs: 0,
  };
  readonly flags: PageFlags = {
    signedIn: true,
    cookieBanner: true,
    overlay: false,
    screenNameDialog: false,
    tabs: true,
    genericSilent: false,
    unknownWidget: false,
  };
  /** Every response the server accepted, oldest first. Tests assert on this. */
  readonly ledger: LedgerEntry[] = [];
  /** Every submission request, whatever its outcome. */
  readonly attempts: SubmitAttempt[] = [];
  /** Participant ids that have loaded a page. */
  readonly participants = new Set<string>();
  /** Number of participant page loads. */
  pageLoads = 0;
  /** Called right after a participant page has been rendered (tests use it to act at that moment). */
  onRender: (() => void) | null = null;

  private readonly polls = new Map<string, PollRecord>();
  private activeId: string | null = null;
  private readonly clients = new Set<Client>();
  /** Recent pushes, so a page that connects late can be sent what it missed. */
  private readonly history: { at: number; frame: string }[] = [];
  private readonly server: http.Server;
  private counter = 0;
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(error));
      });
    });
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  participantUrl(presenter = 'demo'): string {
    return `${this.origin}/pollev/${presenter}`;
  }

  genericUrl(room = 'room'): string {
    return `${this.origin}/generic/${room}`;
  }

  get presenterUrl(): string {
    return `${this.origin}/presenter`;
  }

  get active(): PollRecord | null {
    return this.activeId ? (this.polls.get(this.activeId) ?? null) : null;
  }

  // ------------------------------------------------------------------ presenter actions

  /** Shows a poll to participants. Returns its id. */
  activate(spec: PollSpec): string {
    const id = spec.id ?? `poll-${(this.counter += 1)}-${crypto.randomBytes(3).toString('hex')}`;
    const type = spec.type ?? (spec.options ? 'multiple_choice_poll' : 'free_text_poll');
    const record: PollRecord = {
      id,
      type,
      title: spec.title,
      options: (spec.options ?? []).map((value, index) => ({ id: `${id}-o${index + 1}`, value })),
      maxVotes: spec.maxVotes === undefined ? 1 : spec.maxVotes,
      responsesPerOption: spec.responsesPerOption ?? null,
      editableAnswers: spec.editableAnswers ?? false,
      state: spec.state ?? 'opened',
      titleHidden: spec.titleHidden ?? false,
      webEnabled: true,
      displayState: spec.displayState ?? null,
      round: 0,
    };
    this.polls.set(id, record);
    this.activeId = id;
    this.broadcast('activation', { activity: this.activityPayload(record) });
    return id;
  }

  /** Shows an existing poll again without clearing its responses. */
  reactivate(id: string): void {
    const record = this.polls.get(id);
    if (!record) throw new Error(`no such poll: ${id}`);
    this.activeId = id;
    this.broadcast('activation', { activity: this.activityPayload(record) });
  }

  /** Back to the waiting screen. */
  deactivate(): void {
    this.activeId = null;
    this.broadcast('activation', { activity: null });
  }

  lock(): void {
    this.updateActive({ state: 'closed' });
  }

  unlock(): void {
    this.updateActive({ state: 'opened' });
  }

  /** Clears every response to the active poll, as a presenter can to run a re-vote. */
  clearResponses(): void {
    const record = this.active;
    if (!record) return;
    record.round += 1;
    this.broadcast('poll', { id: record.id, results_count: 0 });
  }

  /**
   * Tells open pages the poll has no responses, without clearing anything on the
   * server: the page forgets the participant's response although it still stands.
   */
  stalePush(): void {
    const record = this.active;
    if (!record) return;
    this.broadcast('poll', { id: record.id, results_count: 0 });
  }

  /** Changes the active poll's title or options in place. */
  edit(change: { title?: string; options?: string[] }): void {
    const record = this.active;
    if (!record) return;
    if (change.title !== undefined) record.title = change.title;
    if (change.options) record.options = change.options.map((value, index) => ({ id: `${record.id}-o${index + 1}`, value }));
    this.broadcast('poll', {
      id: record.id,
      title: record.title,
      options: record.options,
    });
  }

  /** Marks the active poll as full: it takes no more responses. */
  fill(): void {
    this.updateActive({ state: 'maxed_out' });
  }

  private updateActive(change: { state: 'opened' | 'closed' | 'maxed_out' }): void {
    const record = this.active;
    if (!record) return;
    record.state = change.state;
    this.broadcast('poll', { id: record.id, state: record.state });
  }

  /** Makes every open participant page reload itself. */
  forceReload(): void {
    this.broadcast('command', { reload: true }, true);
  }

  /** Sends every open participant page to another address. */
  redirect(to: string): void {
    this.broadcast('command', { redirect: to }, true);
  }

  /** Makes every open participant page throw away and redraw the current poll. */
  remount(): void {
    this.broadcast('command', { remount: true }, true);
  }

  /** Changes a page flag and tells open pages to reload so it takes effect. */
  setFlag<K extends keyof PageFlags>(flag: K, value: PageFlags[K], reload = true): void {
    this.flags[flag] = value;
    if (reload) this.forceReload();
  }

  /** Closes push connections; with `refuse`, also turns new ones away until restored. */
  dropPush(refuse: boolean): void {
    this.faults.pushDown = refuse;
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
  }

  /** Records a response as if a participant had answered by hand in another browser. */
  respondAs(participant: string, pollId: string, answer: { optionIndex?: number; text?: string }): LedgerEntry {
    const record = this.polls.get(pollId);
    if (!record) throw new Error(`no such poll: ${pollId}`);
    const option = answer.optionIndex !== undefined ? record.options[answer.optionIndex] : undefined;
    return this.accept(record, participant, option?.id ?? null, option?.value ?? answer.text ?? '', 'pollev');
  }

  /** Accepted responses for one poll in its current round. */
  responsesFor(pollId: string): LedgerEntry[] {
    const record = this.polls.get(pollId);
    if (!record) return [];
    return this.ledger.filter((entry) => entry.pollId === pollId && entry.round === record.round);
  }

  // ------------------------------------------------------------------ internals

  private accept(record: PollRecord, participant: string, optionId: string | null, value: string, source: 'pollev' | 'generic'): LedgerEntry {
    const entry: LedgerEntry = {
      id: `r${this.ledger.length + 1}`,
      pollId: record.id,
      round: record.round,
      participant,
      optionId,
      value,
      at: new Date().toISOString(),
      source,
    };
    this.ledger.push(entry);
    return entry;
  }

  private activityPayload(record: PollRecord): Record<string, unknown> {
    return {
      id: record.id,
      permalink: record.id,
      type: record.type,
      title: record.title,
      title_hidden: record.titleHidden,
      options: record.options,
      state: record.state,
      web_enabled: record.webEnabled,
      max_votes: record.maxVotes,
      responses_per_option: record.responsesPerOption,
      editable_answers: record.editableAnswers,
      display_state: record.displayState,
      ...(this.faults.omitResultsCount ? {} : { results_count: this.responsesFor(record.id).length }),
      skeleton_ms: this.faults.skeletonMs,
      mount_delay_ms: this.faults.mountDelayMs,
      reuse_mount: this.faults.reuseMount,
      no_restore: this.faults.noRestore,
      equation_ms: this.faults.equationMs,
      push_state_ms: this.faults.pushStateMs,
    };
  }

  private broadcast(event: string, data: unknown, evenIfSilent = false): void {
    if (this.faults.pushSilent && !evenIfSilent) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // Page commands (reload, redirect) are for pages open now; poll changes are kept.
    if (event !== 'command') {
      this.history.push({ at: Date.now(), frame });
      if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    }
    for (const client of this.clients) client.res.write(frame);
  }

  private participantOf(req: http.IncomingMessage, res: http.ServerResponse): string {
    const match = /(?:^|;\s*)mock_participant=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
    if (match?.[1]) return match[1];
    const id = `p-${crypto.randomBytes(6).toString('hex')}`;
    res.setHeader('set-cookie', `mock_participant=${id}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return id;
  }

  private async body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  private html(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (parts[0] === 'static' && parts[1] && method === 'GET') {
      const file = path.join(PUBLIC_DIR, path.basename(parts[1]));
      if (!fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }

    if (parts[0] === 'pollev' && parts[1] && parts.length === 2 && method === 'GET') {
      const participant = this.participantOf(req, res);
      this.participants.add(participant);
      this.pageLoads += 1;
      this.html(res, 200, this.participantPage(parts[1]));
      const hook = this.onRender;
      if (hook) hook();
      return;
    }

    if ((parts[0] === 'pollev' || parts[0] === 'generic') && parts[2] === 'events' && method === 'GET') {
      if (this.faults.pushDown) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 400\n\n');
      // Send what this page missed since it was rendered, as the real push service is asked to.
      const since = Number(url.searchParams.get('since'));
      if (!this.faults.noReplay && Number.isFinite(since) && since > 0) {
        for (const item of this.history) if (item.at >= since) res.write(item.frame);
      }
      const client: Client = { res, channel: parts[0] };
      this.clients.add(client);
      req.on('close', () => this.clients.delete(client));
      return;
    }

    if ((parts[0] === 'pollev' || parts[0] === 'generic') && parts[2] === 'state' && method === 'GET') {
      const record = this.active;
      this.json(res, 200, { activity: record ? this.activityPayload(record) : null, flags: this.flags });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'polls' && parts[2] && parts[3] === 'results') {
      const participant = this.participantOf(req, res);
      const record = this.polls.get(parts[2]);
      if (!record) {
        this.json(res, 404, { error: { type: 'NotFound', message: 'Poll not found', detail: [] } });
        return;
      }
      if (method === 'GET') {
        if (this.faults.resultsDelayMs > 0) await new Promise((r) => setTimeout(r, this.faults.resultsDelayMs));
        if (this.faults.failResults) {
          this.json(res, 500, { error: { type: 'ServerError', message: 'Could not load responses', detail: [] } });
          return;
        }
        const mine = this.ledger
          .filter((e) => e.pollId === record.id && e.round === record.round && e.participant === participant)
          .map((e) => ({ id: e.id, option_id: e.optionId, value: e.value }));
        this.json(res, 200, mine);
        return;
      }
      if (method === 'POST') {
        const body = await this.body(req);
        const source = url.searchParams.get('source') === 'generic' ? 'generic' : 'pollev';
        await this.submit(res, record, participant, body, source);
        return;
      }
    }

    if (parts[0] === 'generic' && parts[1] && parts.length === 2 && method === 'GET') {
      const participant = this.participantOf(req, res);
      this.participants.add(participant);
      this.pageLoads += 1;
      this.html(res, 200, this.genericPage(parts[1]));
      return;
    }

    if (parts[0] === 'login' && method === 'GET') {
      this.html(
        res,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Log in</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="plain"><main><h1>Log in</h1><form onsubmit="return false"><label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="password"></label><button type="submit">Log in</button></form>
<p>This is the mock sign-in page. It does not accept anything.</p></main></body></html>`,
      );
      return;
    }

    if (parts[0] === 'elsewhere' && method === 'GET') {
      this.html(
        res,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Elsewhere</title></head>
<body><main><h1>Some other page</h1><p>Not the poll.</p></main></body></html>`,
      );
      return;
    }

    if (parts[0] === 'presenter' && method === 'GET') {
      this.html(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'presenter.html'), 'utf8'));
      return;
    }

    if (parts[0] === 'control' && method === 'POST') {
      const body = await this.body(req);
      this.json(res, 200, this.control(parts[1] ?? '', body));
      return;
    }
    if (parts[0] === 'control' && parts[1] === 'status' && method === 'GET') {
      this.json(res, 200, this.statusReport());
      return;
    }

    if (parts.length === 0) {
      res.writeHead(302, { location: '/presenter' }).end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  private async submit(
    res: http.ServerResponse,
    record: PollRecord,
    participant: string,
    body: Record<string, unknown>,
    source: 'pollev' | 'generic',
  ): Promise<void> {
    const note = (outcome: SubmitAttempt['outcome'], detail: string): void => {
      this.attempts.push({ pollId: record.id, participant, at: new Date().toISOString(), outcome, detail });
    };
    if (this.faults.submitDelayMs > 0) await new Promise((r) => setTimeout(r, this.faults.submitDelayMs));
    if (this.faults.failSubmits > 0) {
      this.faults.failSubmits -= 1;
      note('failed', 'injected 500');
      this.json(
        res,
        500,
        this.faults.errorWithoutKey
          ? { message: 'Something went wrong' }
          : { error: { type: 'ServerError', message: 'Something went wrong', detail: [{ message: 'Injected failure' }] } },
      );
      return;
    }
    const reject = (message: string): void => {
      note('rejected', message);
      this.json(
        res,
        422,
        this.faults.errorWithoutKey
          ? { message }
          : { error: { type: 'ValidationError', message: 'Response could not be saved', detail: [{ message }] } },
      );
    };
    if (this.activeId !== record.id) return reject('This poll is not active');
    if (record.state === 'maxed_out') return reject('Poll is full');
    if (record.state !== 'opened' || !record.webEnabled) return reject('This poll is locked');
    const mine = this.ledger.filter((e) => e.pollId === record.id && e.round === record.round && e.participant === participant);
    if (record.maxVotes !== null && mine.length >= record.maxVotes) return reject('You have already responded the maximum number of times');

    // A lost reply: the response is recorded, but the connection drops part-way through
    // the answer. (Dropping it before any answer would make the browser resend the
    // request by itself, which is a different case.)
    const reply = (status: number, data: unknown): void => {
      if (this.faults.dropReplies > 0) {
        this.faults.dropReplies -= 1;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': '200' });
        res.write('{"id":');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      this.json(res, status, data);
    };
    if (record.type === 'multiple_choice_poll' || record.type === 'competition') {
      const option = record.options.find((o) => o.id === body['option_id']);
      if (!option) return reject('Unknown option');
      if (record.responsesPerOption !== null && mine.filter((e) => e.optionId === option.id).length >= record.responsesPerOption) {
        return reject('Each option may only be selected once');
      }
      const entry = this.accept(record, participant, option.id, option.value, source);
      note('accepted', option.value);
      reply(200, { id: entry.id, option_id: option.id });
      return;
    }
    if (record.type === 'free_text_poll') {
      const value = typeof body['value'] === 'string' ? body['value'].trim() : '';
      if (value === '') return reject('Response is empty');
      const entry = this.accept(record, participant, null, value, source);
      note('accepted', value);
      reply(200, { id: entry.id, value });
      return;
    }
    // Other activity types exist on the page but the mock does not score them.
    const entry = this.accept(record, participant, null, JSON.stringify(body), source);
    note('accepted', record.type);
    this.json(res, 200, { id: entry.id });
  }

  private statusReport(): Record<string, unknown> {
    const record = this.active;
    return {
      active: record ? { id: record.id, type: record.type, title: record.title, state: record.state, responses: this.responsesFor(record.id).length } : null,
      ledger: this.ledger.length,
      attempts: this.attempts.length,
      participants: this.participants.size,
      faults: this.faults,
      flags: this.flags,
      recent: this.ledger.slice(-10).reverse(),
    };
  }

  /** The presenter page drives the site through this. */
  private control(action: string, body: Record<string, unknown>): Record<string, unknown> {
    switch (action) {
      case 'activate':
        this.activate(body as unknown as PollSpec);
        break;
      case 'deactivate':
        this.deactivate();
        break;
      case 'lock':
        this.lock();
        break;
      case 'unlock':
        this.unlock();
        break;
      case 'clear':
        this.clearResponses();
        break;
      case 'reload':
        this.forceReload();
        break;
      case 'remount':
        this.remount();
        break;
      case 'drop-push':
        this.dropPush(false);
        break;
      case 'fault': {
        const name = body['name'] as keyof Faults;
        if (name in this.faults) (this.faults as unknown as Record<string, unknown>)[name] = body['value'];
        break;
      }
      case 'flag': {
        const name = body['name'] as keyof PageFlags;
        if (name in this.flags) this.setFlag(name, body['value'] === true);
        break;
      }
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
    return { ok: true, ...this.statusReport() };
  }

  // ------------------------------------------------------------------ pages

  private participantPage(presenter: string): string {
    const record = this.active;
    const name = esc(presenter);
    const initial = record ? JSON.stringify(this.activityPayload(record)).replace(/</g, '\\u003c') : 'null';
    const cookie = this.flags.cookieBanner
      ? `<div aria-label="Accept our Cookie Policy" class="cookie-region" role="region" tabindex="0">
<div id="cookie-consent-banner" role="status" aria-label="info notification">
<div class="cookie-title">Accept our Cookie Policy</div>
<p>This mock site sets one cookie so it can tell participants apart.</p>
<div class="cookie-actions"><button name="button" type="button" data-dismiss="true">Dismiss</button><button name="button" type="button" data-agree="true">Agree</button></div>
</div></div>`
      : '';
    const account = this.flags.signedIn
      ? '<a href="/pollev/settings-not-implemented" data-turbo="false"><span>Settings</span></a>'
      : '<a data-turbo="false" href="/login"><span>Log in</span></a>';
    const dialog = this.flags.screenNameDialog
      ? `<div class="modal"><div class="scrim"></div><turbo-frame role="dialog" aria-modal="true" aria-label="Screen name configuration" class="sheet">
<h2>What should we call you?</h2><form onsubmit="return false"><label>Screen name <input type="text" name="screen_name"></label><button type="submit">Continue</button></form></turbo-frame></div>`
      : '';
    const overlay = this.flags.overlay ? '<div id="click-eater" aria-hidden="true"></div>' : '';
    return `<!doctype html>
<html class="h-full" lang="en">
<head>
<meta charset="utf-8">
<title>${name}’s presentation | Mock Poll Everywhere</title>
<meta name="viewport" content="initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body data-participate="" data-presenter="${name}" data-unknown-widget="${this.flags.unknownWidget ? 'true' : 'false'}">
<div id="skipnav"><ul><li><a href="#main-content">skip to main content</a></li><li><a href="#navigation">skip to side bar navigation</a></li></ul></div>
${cookie}
<nav data-turbo="false" id="navigation"><div class="nav-items">
<a aria-label="Poll Everywhere" href="/pollev/${name}"><span>PE</span></a>
<a href="/pollev/${name}"><span>Home</span></a>
<a href="/pollev/${name}"><span>History</span></a>
<a data-turbo="false" href="/pollev/${name}"><span>Registration</span></a>
${account}
</div></nav>
<main id="main-content">
<div data-controller="page-visible location"><turbo-cable-stream-source channel="ActivationChannel" signed-stream-name="mock"></turbo-cable-stream-source></div>
<div id="participate_presenter_bar" class="${this.flags.tabs ? '' : 'hidden'}">
<div aria-label="Switch between live and pinned activities" role="tablist">
<form class="button_to" method="get" action="/pollev/${name}/active"><button id="presenter_bar_current_tab" role="tab" data-tab="current" aria-selected="true" type="submit">Waiting…</button></form>
<form class="button_to" method="get" action="/pollev/${name}/pinned"><button id="presenter_bar_pinned_tab" role="tab" data-tab="pinned" aria-selected="false" type="submit">Pinned</button></form>
</div>
</div>
${dialog}
<turbo-frame class="block" aria-live="polite" id="active_tab_content"><turbo-frame id="participate_presenter_${name}" src=""></turbo-frame></turbo-frame>
<notification-manager></notification-manager>
</main>
${overlay}
<script>window.__mockInitialActivity = ${initial}; window.__mockRenderedAt = ${Date.now()}; window.__mockWaitingFlashMs = ${this.faults.waitingFlashMs};</script>
<script src="/static/pollev.js"></script>
</body>
</html>`;
  }

  private genericPage(room: string): string {
    const record = this.active;
    const initial = record ? JSON.stringify(this.activityPayload(record)).replace(/</g, '\\u003c') : 'null';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Room ${esc(room)} | Mock generic poll</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="plain" data-room="${esc(room)}" data-silent="${this.flags.genericSilent ? 'true' : 'false'}">
<header><nav><button type="button" id="help">Help</button><button type="button" id="about">About</button></nav></header>
<main><h1>Room ${esc(room)}</h1><div id="poll"></div></main>
<script>window.__mockInitialActivity = ${initial};</script>
<script src="/static/generic.js"></script>
</body>
</html>`;
  }
}

export async function startMockSite(port = 0): Promise<MockSite> {
  return new MockSite().start(port);
}
