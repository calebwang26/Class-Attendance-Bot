import type { CheckInState, PageSnapshot, SnapshotOption, SnapshotPoll } from '../types.ts';

/** Name of the object the agent installs on `window`. */
export const AGENT_GLOBAL = '__pollbot';
/** Name of the function the page calls to tell Node that something changed. */
export const NOTIFY_BINDING = '__pollbotNotify';
/** Bumped whenever the snapshot shape or extraction logic changes. */
export const AGENT_VERSION = 2;

export interface PageAgent {
  version: number;
  snapshot(): PageSnapshot;
  resolve(ref: string): Element | null;
}

/**
 * Runs inside the page. Playwright serialises this function's source and
 * evaluates it in every document, so it must be completely self-contained:
 * no imports, no references to anything declared outside its own body.
 * (The three constants above are therefore repeated inside; a unit test
 * checks they agree.)
 *
 * It does two things and changes nothing on the page:
 *   1. watches the DOM and tells Node when it changes;
 *   2. on request, describes what the page is showing (`snapshot`) and hands
 *      back elements the description referred to (`resolve`).
 *
 * The Poll Everywhere selectors come from that site's own participant
 * scripts; docs/TECHNICAL_DESIGN.md records where each one was established.
 */
export function installPageAgent(options: { quietMs: number }): void {
  const KEY = '__pollbot';
  const NOTIFY = '__pollbotNotify';
  const VERSION = 2;

  const win = window as unknown as Record<string, unknown>;
  const existing = win[KEY] as { version?: number } | undefined;
  if (existing && existing.version === VERSION) return;
  // Only the top-level document is watched; polls inside iframes are out of scope.
  if (window.top !== window) return;

  const refs = new Map<string, Element>();
  const refOf = new WeakMap<Element, string>();
  let refCounter = 0;
  // References are unique per document, so an element on a reloaded page never
  // gets the same reference as one on the page before.
  const docTag = Math.random().toString(36).slice(2, 8);
  const signals: { saved: number; errors: number; lastError: string | null } = {
    saved: 0,
    errors: 0,
    lastError: null,
  };
  // Whether this document has completed a successful request to an address ending in
  // /results, which is how Poll Everywhere fetches a participant's earlier responses.
  // Resource timing belongs to this document alone, so a request made by the page
  // before a reload can never count for the page after it.
  let resultsLoaded = false;
  const noteResource = (entry: PerformanceEntry): void => {
    const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
    if (timing.initiatorType !== 'xmlhttprequest' && timing.initiatorType !== 'fetch') return;
    let path = '';
    try {
      path = new URL(timing.name).pathname;
    } catch {
      return;
    }
    if (!/\/results\/?$/.test(path)) return;
    const status = typeof timing.responseStatus === 'number' ? timing.responseStatus : 0;
    if (status >= 200 && status < 300) resultsLoaded = true;
  };
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(noteResource)).observe({ type: 'resource', buffered: true });
  } catch {
    // Without resource timing the bot never treats "open" as confirmed by the server.
  }

  const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (el: Element | null | undefined): boolean => {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  };

  const textOf = (el: Element | null | undefined): string => {
    if (!el) return '';
    const html = el as HTMLElement;
    return clean(typeof html.innerText === 'string' ? html.innerText : el.textContent);
  };

  const refFor = (el: Element): string => {
    let id = refOf.get(el);
    if (!id) {
      refCounter += 1;
      id = `${docTag}-${refCounter}`;
      refOf.set(el, id);
    }
    refs.set(id, el);
    return id;
  };

  const pruneRefs = (): void => {
    for (const [id, el] of refs) if (!el.isConnected) refs.delete(id);
  };

  const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));

  const LOGIN_PATH = /^\/(login|log_in|log-in|signin|sign_in|sign-in|sessions?|sso|saml|oauth|auth|registrations?|register)(\/|$)/i;

  const authGate = (): { required: boolean; reason: string | null } => {
    if (all(document, 'input[type="password"]').some(isVisible)) {
      return { required: true, reason: 'a password field is showing' };
    }
    if (LOGIN_PATH.test(window.location.pathname)) {
      return { required: true, reason: `the page is ${window.location.pathname}` };
    }
    return { required: false, reason: null };
  };

  const blockingDialog = (): string | null => {
    const dialogs = all(document, '[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]');
    for (const dialog of dialogs) {
      if (!isVisible(dialog)) continue;
      return clean(dialog.getAttribute('aria-label')) || textOf(dialog).slice(0, 80) || 'dialog';
    }
    return null;
  };

  // Poll Everywhere's location check-in panel, run by its "participate--check-in"
  // script. Its "Check in" button makes the page ask the browser for the location
  // and send it; "Continue without check-in" is never touched.
  const CHECK_IN_FAILED = /We were unable to check you in/i;
  const checkInState = (): CheckInState => {
    const state: CheckInState = { showing: false, buttonRef: null, failed: false };
    for (const panel of all(document, '[data-controller~="participate--check-in"]')) {
      if (!isVisible(panel)) continue;
      state.showing = true;
      const buttons = all(panel, 'button, [role="button"], input[type="submit"], input[type="button"]').filter(
        (b) => isVisible(b) && /^check in$/i.test(textOf(b) || clean((b as HTMLInputElement).value) || clean(b.getAttribute('aria-label'))),
      );
      if (buttons.length === 1 && (buttons[0] as HTMLButtonElement).disabled !== true) state.buttonRef = refFor(buttons[0] as Element);
      break;
    }
    if (CHECK_IN_FAILED.test(document.body.textContent ?? '')) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (CHECK_IN_FAILED.test(node.textContent ?? '') && isVisible(node.parentElement)) {
          state.failed = true;
          break;
        }
      }
    }
    return state;
  };

  const emptyPoll = (): SnapshotPoll => ({
    siteId: null,
    kind: 'unsupported',
    siteType: null,
    unsupportedType: null,
    question: '',
    options: [],
    textInput: null,
    submit: null,
    ownResponses: [],
    savedResponses: null,
    pendingResponses: null,
    answeredMarker: false,
    closedMarker: false,
    statusText: '',
    incomplete: false,
    mountRef: null,
    competition: false,
  });

  // ---------------------------------------------------------------- Poll Everywhere

  const PE_ANSWERED = /Response recorded|You have responded|You have \d+ responses? remaining/i;
  const PE_CLOSED = /This poll is locked|Poll is full|Web Voting has not been turned on/i;
  const MC = 'component-response-multiple-choice';
  const OE = 'component-response-open-ended';

  const isPollEverywhere = (): boolean => {
    const host = window.location.hostname.toLowerCase();
    if (host === 'pollev.com' || host.endsWith('.pollev.com') || host.endsWith('.polleverywhere.com')) return true;
    return document.querySelector('#active_tab_content, legacy-response-view, .component-response-activity') !== null;
  };

  const pollEverywherePoll = (activity: Element): SnapshotPoll | null => {
    const poll = emptyPoll();
    const siteType = clean(activity.getAttribute('data-activity-type'));
    poll.siteType = siteType || null;
    poll.mountRef = refFor(activity);

    // The mount element keeps the activity's model. Its permalink identifies the
    // poll, and its list of results says which responses the server has saved
    // (a saved result has an id and is no longer marked pending).
    try {
      interface ResultModel {
        id?: unknown;
        has?: (key: string) => boolean;
      }
      const mount = activity.closest('legacy-response-view') as
        | (Element & {
            responseView?: {
              model?: { get?: (key: string) => unknown; id?: unknown; results?: { models?: ResultModel[] } };
            };
          })
        | null;
      const model = mount?.responseView?.model;
      if (model && typeof model.get === 'function') {
        const id = model.get('permalink') ?? model.get('shared_key') ?? model.id;
        if (typeof id === 'string' || typeof id === 'number') poll.siteId = String(id);
        const results = model.results?.models;
        if (Array.isArray(results)) {
          const pending = (r: ResultModel): boolean => typeof r.has === 'function' && r.has('isPending');
          poll.savedResponses = results.filter((r) => r && r.id !== undefined && r.id !== null && !pending(r)).length;
          poll.pendingResponses = results.filter((r) => r && pending(r)).length;
        }
      }
    } catch {
      // Both are extras; the page's visible state is enough without them.
    }

    const has = (cls: string): boolean => activity.querySelector(`.${cls}`) !== null;
    const mcRoot = activity.querySelector(`.${MC}`);
    const oeRoot = activity.querySelector(`.${OE}`);

    let unsupported: string | null = null;
    if (siteType === 'survey' || has('component-response-survey')) unsupported = 'survey';
    else if (siteType === 'discourse' || has('component-response-qa')) unsupported = 'q_and_a';
    else if (siteType === 'ranking_poll' || has('component-response-rank-order')) unsupported = 'rank_order';
    else if (siteType === 'clickable_image' || has('component-response-clickable-image')) unsupported = 'clickable_image';

    const header =
      (mcRoot ?? oeRoot)?.querySelector('.component-response-header') ??
      activity.querySelector('.component-response-header');
    const title = header?.querySelector('.component-response-header__title') ?? null;
    const status = header?.querySelector('.component-response-header__status') ?? null;
    // A presenter can hide the title from participants; the page then shows a fixed
    // placeholder text, which is not the question.
    const titleHidden = header?.classList.contains('component-response-header--title-hidden') === true;
    poll.question = titleHidden ? '' : textOf(title) || clean(title?.getAttribute('aria-label'));
    poll.competition = has('component-response-competition');
    // Equations are drawn by a script fetched on demand; until then a placeholder shows,
    // and the text would change under the bot's feet.
    const equationsPending = activity.querySelector('.latex--container[data-rendered="false"]') !== null;
    poll.statusText = isVisible(status) ? textOf(status) : '';
    poll.answeredMarker = PE_ANSWERED.test(poll.statusText);
    poll.closedMarker = PE_CLOSED.test(poll.statusText);

    if (unsupported) {
      poll.kind = 'unsupported';
      poll.unsupportedType = unsupported;
      return poll;
    }

    if (mcRoot) {
      poll.kind = 'multiple_choice';
      const wrappers = all(mcRoot, `.${MC}__option`).filter(isVisible);
      const options: SnapshotOption[] = [];
      wrappers.forEach((wrapper, index) => {
        const button = wrapper.querySelector(`.${MC}__option__vote`) as HTMLButtonElement | null;
        if (!button) return;
        const value = wrapper.querySelector(`.${MC}__option__value`);
        let label = textOf(value);
        if (!label) label = clean(value?.querySelector('img')?.getAttribute('alt'));
        if (!label) {
          label = clean(
            (button.getAttribute('aria-label') ?? '').replace(/ with (your vote|\d+ of your votes), option \d+ of \d+$/i, ''),
          );
        }
        if (!label) label = `Option ${index + 1}`;
        options.push({
          ref: refFor(button),
          label,
          disabled: button.disabled,
          selected: wrapper.hasAttribute('data-vote-count') || wrapper.classList.contains(`${MC}__option--vote`),
        });
      });
      // Options with the same label (image options without alt text all read
      // "Image option") get their position added, so each one can be told apart.
      const counts = new Map<string, number>();
      for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
      options.forEach((option, index) => {
        if ((counts.get(option.label) ?? 0) > 1) option.label = `${option.label} (${index + 1})`;
      });
      poll.options = options;
      poll.incomplete = options.length === 0 || equationsPending;
      return poll;
    }

    if (oeRoot) {
      poll.kind = 'free_text';
      const textarea = oeRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      // Only the form's own submit control. The list of earlier responses has buttons
      // too, and those delete a response.
      const submit = (textarea?.form ?? null)?.querySelector('input[type="submit"], button[type="submit"]') as
        | HTMLInputElement
        | HTMLButtonElement
        | null;
      if (textarea && isVisible(textarea)) {
        poll.textInput = {
          ref: refFor(textarea),
          disabled: textarea.disabled,
          value: textarea.value,
          maxLength: textarea.maxLength > 0 ? textarea.maxLength : null,
        };
      }
      if (submit && isVisible(submit)) {
        poll.submit = {
          ref: refFor(submit),
          disabled: submit.disabled,
          label: clean((submit as HTMLInputElement).value) || textOf(submit) || 'Submit',
        };
      }
      poll.ownResponses = all(oeRoot, `.${OE}__result__value`)
        .filter(isVisible)
        .map(textOf)
        .filter((text) => text !== '');
      poll.incomplete = poll.textInput === null || equationsPending;
      return poll;
    }

    // A known answerable type whose controls have not been drawn yet.
    if (siteType === 'multiple_choice_poll' || siteType === 'free_text_poll') {
      if (has('component-response-competition')) return null; // between competition questions
      poll.kind = siteType === 'multiple_choice_poll' ? 'multiple_choice' : 'free_text';
      poll.incomplete = true;
      return poll;
    }
    if (siteType === 'competition' || has('component-response-competition')) return null;

    poll.kind = 'unsupported';
    poll.unsupportedType = siteType || 'unknown';
    return poll;
  };

  const pollEverywhere = (base: PageSnapshot): PageSnapshot => {
    const snapshot = base;
    snapshot.adapter = 'pollev';

    const frame = document.querySelector('#active_tab_content');
    const anyActivity = document.querySelector('.component-response-activity, legacy-response-view');
    const scope: Element | null = frame ?? (anyActivity ? document.body : null);
    snapshot.scopeFound = scope !== null;

    // The element that receives "a poll was activated" pushes. Its channel object
    // knows the true state; the "connected" attribute can stay set while the socket
    // is being re-established, so it is only the fallback.
    const sources = all(document, 'turbo-cable-stream-source');
    const activation = sources.find((s) => s.getAttribute('channel') === 'ActivationChannel') ?? sources[0];
    if (activation) {
      let state: unknown;
      try {
        state = (activation as Element & { channel?: { state?: unknown } }).channel?.state;
      } catch {
        state = undefined;
      }
      snapshot.pushConnected = typeof state === 'string' ? state === 'connected' : activation.hasAttribute('connected');
    }

    const nav = document.querySelector('nav#navigation, nav');
    if (nav) snapshot.signedIn = nav.querySelector('a[href="/login"], a[href$="/login"]') === null;

    const currentTab = document.querySelector('[data-tab="current"]');
    if (currentTab) snapshot.liveTabSelected = currentTab.getAttribute('aria-selected') !== 'false';

    snapshot.cookieBanner = isVisible(document.querySelector('#cookie-consent-banner'));

    if (!scope) return snapshot;
    snapshot.scopeText = textOf(scope).slice(0, 600);

    const activity = all(scope, '.component-response-activity').find(isVisible) ?? null;
    if (activity) {
      snapshot.poll = pollEverywherePoll(activity);
      return snapshot;
    }

    // A mount element with nothing drawn in it yet: the activity is on its way.
    if (scope.querySelector('legacy-response-view') !== null) {
      const pending = emptyPoll();
      pending.incomplete = true;
      snapshot.poll = pending;
      return snapshot;
    }

    const checkIn = all(scope, '[data-controller~="participate--check-in"]').find(isVisible);
    if (checkIn) {
      const poll = emptyPoll();
      poll.unsupportedType = 'attendance_check_in';
      poll.siteType = 'check_in';
      poll.question = textOf(scope.querySelector('h1, h2, h3')) || 'Attendance check-in';
      snapshot.poll = poll;
      return snapshot;
    }

    // Anything else a person could operate in the activity area is something this
    // extractor does not understand. Report it rather than guess.
    snapshot.unknownControls = all(
      scope,
      'button, input:not([type="hidden"]), textarea, select, [role="button"], [role="radio"], [role="checkbox"]',
    ).filter(isVisible).length;
    return snapshot;
  };

  // ---------------------------------------------------------------- Poll Everywhere 2.0

  // Server-rendered (Rails and Turbo). Read from the live page: the activity sits in
  // #respond_actions_question_<id> inside .ui-format; each multiple-choice option is
  // a button[role=radio] (class ui-format__choice-button) in its own form, and
  // clicking it submits the vote; the header says "Not signed in" for a guest.
  const isPollEverywhere2 = (): boolean => {
    const host = window.location.hostname.toLowerCase();
    return host === 'pe.app' || host.endsWith('.pe.app') || document.querySelector('.ui-participant') !== null;
  };

  const pollEverywhere2 = (base: PageSnapshot): PageSnapshot => {
    const snapshot = base;
    snapshot.adapter = 'pollev2';
    const root = document.querySelector('.ui-participant');
    snapshot.scopeFound = root !== null;

    const sources = all(document, 'turbo-cable-stream-source');
    if (sources.length > 0) {
      snapshot.pushConnected = sources.every((source) => {
        let state: unknown;
        try {
          state = (source as Element & { channel?: { state?: unknown } }).channel?.state;
        } catch {
          state = undefined;
        }
        return typeof state === 'string' ? state === 'connected' : source.hasAttribute('connected');
      });
    }

    const header = root?.querySelector('header') ?? null;
    if (header) snapshot.signedIn = !/Not signed in/i.test(textOf(header));

    if (!root) return snapshot;
    snapshot.scopeText = textOf(root).slice(0, 600);

    const actions = root.querySelector('[id^="respond_actions_question_"]');
    const format = actions?.closest('.ui-format') ?? root.querySelector('.ui-format');
    if (!format) return snapshot;

    const poll = emptyPoll();
    const idMatch = /(\d+)$/.exec(actions?.id ?? '');
    poll.siteId = idMatch?.[1] ?? null;
    const formatClass = Array.from(format.classList).find((c) => c.startsWith('ui-format-'));
    poll.siteType = formatClass ? formatClass.slice('ui-format-'.length) : null;
    poll.question = textOf(root.querySelector('.ui-question-title'));
    poll.mountRef = refFor(actions ?? format);
    const formatText = textOf(format);
    poll.answeredMarker = GENERIC_ANSWERED.test(formatText);
    poll.closedMarker = GENERIC_CLOSED.test(formatText);

    const choices = (all(format, '.ui-format__choice-button, [role="radio"]') as HTMLElement[]).filter(isVisible);
    if (choices.length > 0) {
      poll.kind = 'multiple_choice';
      poll.options = choices.map((button, index) => {
        const label = textOf(button.querySelector('.ui-format__choice-label')) || textOf(button) || `Option ${index + 1}`;
        return {
          ref: refFor(button),
          label,
          disabled: (button as HTMLButtonElement).disabled === true || button.getAttribute('aria-disabled') === 'true',
          selected: button.getAttribute('aria-checked') === 'true',
        };
      });
      const counts = new Map<string, number>();
      for (const option of poll.options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
      poll.options.forEach((option, index) => {
        if ((counts.get(option.label) ?? 0) > 1) option.label = `${option.label} (${index + 1})`;
      });
      snapshot.poll = poll;
      return snapshot;
    }

    const textarea = (all(format, 'textarea') as HTMLTextAreaElement[]).find(isVisible) ?? null;
    if (textarea) {
      poll.kind = 'free_text';
      poll.textInput = {
        ref: refFor(textarea),
        disabled: textarea.disabled,
        value: textarea.value,
        maxLength: textarea.maxLength > 0 ? textarea.maxLength : null,
      };
      const submit = textarea.form?.querySelector('[type="submit"]') as HTMLButtonElement | HTMLInputElement | null;
      if (submit && isVisible(submit)) {
        poll.submit = {
          ref: refFor(submit),
          disabled: submit.disabled,
          label: textOf(submit) || clean((submit as HTMLInputElement).value) || 'Submit',
        };
      }
      snapshot.poll = poll;
      return snapshot;
    }

    poll.kind = 'unsupported';
    poll.unsupportedType = poll.siteType ?? 'unknown';
    snapshot.poll = poll;
    return snapshot;
  };

  // ---------------------------------------------------------------- Generic pages

  const GENERIC_ANSWERED =
    /response (was |has been |is )?(recorded|received|submitted|saved)|thank(s| you) for (responding|voting|your (response|vote|answer))|you('ve| have) (already )?(responded|voted|answered)/i;
  const GENERIC_CLOSED = /(poll|voting|question) (is |has been |was )?(closed|locked|ended)/i;
  const SUBMIT_WORDS = /^(submit|send|vote|respond|answer|confirm|save)\b/i;

  const labelOf = (input: HTMLInputElement): { text: string; target: Element } => {
    const label = (input.labels && input.labels[0]) || input.closest('label');
    const text =
      textOf(label) || clean(input.getAttribute('aria-label')) || clean(input.value) || clean(input.id) || 'option';
    const target = isVisible(input) ? input : (label ?? input);
    return { text, target };
  };

  const findSubmit = (container: Element): HTMLElement | null => {
    const candidates = all(container, 'button, input[type="submit"], [role="button"]').filter(isVisible) as HTMLElement[];
    const typed = candidates.find((c) => c.getAttribute('type') === 'submit');
    if (typed) return typed;
    return candidates.find((c) => SUBMIT_WORDS.test(textOf(c) || clean((c as HTMLInputElement).value))) ?? null;
  };

  const questionNear = (container: Element, scope: Element): string => {
    const legend = container.closest('fieldset')?.querySelector('legend') ?? container.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);
    const labelled = container.closest('[aria-label]');
    if (labelled && scope.contains(labelled) && clean(labelled.getAttribute('aria-label'))) {
      return clean(labelled.getAttribute('aria-label'));
    }
    const headings = all(scope, 'h1, h2, h3, h4, [role="heading"]').filter(isVisible);
    let best = '';
    for (const heading of headings) {
      // The last heading that comes before the controls in document order.
      if (heading.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING) best = textOf(heading) || best;
    }
    return best || textOf(headings[0]) || clean(document.title);
  };

  const generic = (base: PageSnapshot): PageSnapshot => {
    const snapshot = base;
    snapshot.adapter = 'generic';
    const scope = document.querySelector('main, [role="main"]') ?? document.body;
    if (!scope) return snapshot;
    snapshot.scopeFound = true;
    const scopeText = textOf(scope);
    snapshot.scopeText = scopeText.slice(0, 600);

    // Multiple choice: the largest group of two or more radio buttons sharing a name.
    const radios = (all(scope, 'input[type="radio"]') as HTMLInputElement[]).filter((r) => {
      const { target } = labelOf(r);
      return isVisible(target);
    });
    const groups = new Map<string, HTMLInputElement[]>();
    for (const radio of radios) {
      const key = `${radio.form ? refFor(radio.form) : 'no-form'}|${radio.name}`;
      const list = groups.get(key) ?? [];
      list.push(radio);
      groups.set(key, list);
    }
    let group: HTMLInputElement[] = [];
    for (const list of groups.values()) if (list.length >= 2 && list.length > group.length) group = list;

    if (group.length >= 2) {
      const first = group[0] as HTMLInputElement;
      const container = first.form ?? first.closest('fieldset, [role="radiogroup"]') ?? scope;
      const poll = emptyPoll();
      poll.kind = 'multiple_choice';
      poll.mountRef = refFor(container);
      poll.question = questionNear(first.closest('fieldset, [role="radiogroup"]') ?? first, scope);
      poll.options = group.map((radio) => {
        const { text, target } = labelOf(radio);
        const fieldset = radio.closest('fieldset') as HTMLFieldSetElement | null;
        return {
          ref: refFor(target),
          label: text,
          disabled: radio.disabled || (fieldset ? fieldset.disabled : false),
          selected: radio.checked,
        };
      });
      const submit = findSubmit(container);
      if (submit) {
        poll.submit = {
          ref: refFor(submit),
          disabled: (submit as HTMLButtonElement).disabled === true,
          label: textOf(submit) || clean((submit as unknown as HTMLInputElement).value) || 'Submit',
        };
      }
      poll.answeredMarker = GENERIC_ANSWERED.test(scopeText);
      poll.closedMarker = GENERIC_CLOSED.test(scopeText);
      snapshot.poll = poll;
      return snapshot;
    }

    // Free text: exactly one visible textarea.
    const textareas = (all(scope, 'textarea') as HTMLTextAreaElement[]).filter(isVisible);
    if (textareas.length === 1) {
      const textarea = textareas[0] as HTMLTextAreaElement;
      const container = textarea.form ?? textarea.parentElement ?? scope;
      const poll = emptyPoll();
      poll.kind = 'free_text';
      poll.mountRef = refFor(container);
      poll.question = questionNear(textarea, scope);
      poll.textInput = {
        ref: refFor(textarea),
        disabled: textarea.disabled,
        value: textarea.value,
        maxLength: textarea.maxLength > 0 ? textarea.maxLength : null,
      };
      const submit = findSubmit(container);
      if (submit) {
        poll.submit = {
          ref: refFor(submit),
          disabled: (submit as HTMLButtonElement).disabled === true,
          label: textOf(submit) || clean((submit as unknown as HTMLInputElement).value) || 'Submit',
        };
      }
      poll.answeredMarker = GENERIC_ANSWERED.test(scopeText);
      poll.closedMarker = GENERIC_CLOSED.test(scopeText);
      snapshot.poll = poll;
      return snapshot;
    }

    return snapshot;
  };

  // ---------------------------------------------------------------- Snapshot

  const snapshot = (): PageSnapshot => {
    pruneRefs();
    const auth = authGate();
    const base: PageSnapshot = {
      agentVersion: VERSION,
      docStartedAt: Math.round(performance.timeOrigin),
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      online: navigator.onLine,
      adapter: 'generic',
      scopeFound: false,
      pushConnected: null,
      resultsLoaded,
      signedIn: null,
      authRequired: auth.required,
      authReason: auth.reason,
      blockingDialog: null,
      checkIn: { showing: false, buttonRef: null, failed: false },
      liveTabSelected: null,
      unknownControls: 0,
      cookieBanner: false,
      signals: { saved: signals.saved, errors: signals.errors, lastError: signals.lastError },
      poll: null,
      scopeText: '',
    };
    if (!document.body) return base;
    base.blockingDialog = blockingDialog();
    base.checkIn = checkInState();
    if (isPollEverywhere2()) return pollEverywhere2(base);
    return isPollEverywhere() ? pollEverywhere(base) : generic(base);
  };

  const agent: PageAgent = {
    version: VERSION,
    snapshot,
    resolve: (ref: string): Element | null => {
      const el = refs.get(ref);
      return el && el.isConnected ? el : null;
    },
  };
  win[KEY] = agent;

  // ---------------------------------------------------------------- Change notification

  let lastNotify = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const notify = (reason: string): void => {
    const now = Date.now();
    if (now - lastNotify < options.quietMs) {
      // Too soon after the last notice: send one more when the burst is over, so the
      // final state of the page is always reported.
      if (trailing === null) {
        trailing = setTimeout(() => {
          trailing = null;
          notify(reason);
        }, options.quietMs);
      }
      return;
    }
    lastNotify = now;
    try {
      const send = win[NOTIFY];
      if (typeof send === 'function') {
        const result = (send as (reason: string) => unknown)(reason);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(() => undefined);
        }
      }
    } catch {
      // Node is not listening (yet); the periodic read covers it.
    }
  };

  // Mutation callbacks are microtasks, so unlike timers they are not throttled
  // when the tab is in the background. Debouncing is done on the Node side.
  new MutationObserver(() => notify('mutation')).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  // Poll Everywhere raises these on the activity element: "result" once the
  // server has saved a response, "notification:show" for errors and messages.
  document.addEventListener(
    'result',
    (event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.component-response-activity')) {
        signals.saved += 1;
        lastNotify = 0;
        notify('saved');
      }
    },
    true,
  );
  document.addEventListener(
    'notification:show',
    (event) => {
      const detail = (event as CustomEvent<{ type?: unknown; title?: unknown; content?: unknown } | null>).detail;
      if (detail && detail.type === 'error') {
        signals.errors += 1;
        signals.lastError = clean(typeof detail.content === 'string' ? detail.content : String(detail.title ?? 'error')).slice(0, 200);
        lastNotify = 0;
        notify('error');
      }
    },
    true,
  );
  window.addEventListener('online', () => notify('online'));
  window.addEventListener('offline', () => notify('offline'));
}
