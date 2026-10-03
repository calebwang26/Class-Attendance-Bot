import type { PageSnapshot, Poll, PollStatus, Recognition, SnapshotPoll } from '../types.ts';
import { fingerprintOf } from './fingerprint.ts';

export interface RecognizeOptions {
  /**
   * On sites where the page shows whether the participant is signed in, treat
   * "signed out" as something the user must fix before any poll is answered.
   */
  requireSignIn: boolean;
}

/** Works out whether the poll can be answered now, and what on the page says so. */
export function pollStatus(snapshot: PageSnapshot, poll: SnapshotPoll): { status: PollStatus; evidence: string } {
  const status = poll.statusText ? ` (status: "${poll.statusText}")` : '';

  if (poll.kind === 'multiple_choice') {
    const selected = poll.options.filter((o) => o.selected);
    const anyEnabled = poll.options.some((o) => !o.disabled);
    if (snapshot.adapter === 'pollev' || snapshot.adapter === 'pollev2') {
      // On Poll Everywhere a click is a vote, so an option marked as voted is a response.
      if (selected.length > 0) {
        return { status: 'answered', evidence: `"${selected[0]?.label ?? ''}" is marked as your vote${status}` };
      }
      if (poll.answeredMarker) return { status: 'answered', evidence: `the page says a response was recorded${status}` };
      if (poll.closedMarker || !anyEnabled) return { status: 'closed', evidence: `no option can be selected${status}` };
      return { status: 'open', evidence: `options are selectable${status}` };
    }
    // Elsewhere a ticked radio button may not have been submitted yet.
    if (poll.answeredMarker) return { status: 'answered', evidence: 'the page says a response was recorded' };
    if (!anyEnabled) {
      return selected.length > 0
        ? { status: 'answered', evidence: 'the options are disabled with a choice kept' }
        : { status: 'closed', evidence: 'no option can be selected' };
    }
    if (poll.closedMarker) return { status: 'closed', evidence: 'the page says the poll is closed' };
    return { status: 'open', evidence: 'options are selectable' };
  }

  if (poll.kind === 'free_text') {
    if (poll.ownResponses.length > 0) {
      return { status: 'answered', evidence: `your response is listed on the page${status}` };
    }
    if (poll.answeredMarker) return { status: 'answered', evidence: `the page says a response was recorded${status}` };
    if (!poll.textInput || poll.textInput.disabled || poll.closedMarker) {
      return { status: 'closed', evidence: `the text box cannot be used${status}` };
    }
    return { status: 'open', evidence: `the text box accepts input${status}` };
  }

  if (poll.closedMarker) return { status: 'closed', evidence: `the page says it is closed${status}` };
  if (poll.answeredMarker) return { status: 'answered', evidence: `the page says a response was recorded${status}` };
  return { status: 'open', evidence: `unsupported activity${status}` };
}

/**
 * Turns the raw facts of a snapshot into a single page state. Pure: no I/O,
 * no clock. The order of the checks is the order of precedence.
 */
export function recognize(snapshot: PageSnapshot, options: RecognizeOptions): Recognition {
  if (snapshot.readyState === 'loading') return { state: 'loading', reason: 'the document is still loading' };

  if (snapshot.authRequired) {
    return { state: 'needs_user', reason: 'sign_in', detail: snapshot.authReason ?? 'a sign-in page is showing' };
  }
  if (snapshot.blockingDialog !== null) {
    return { state: 'needs_user', reason: 'dialog', detail: snapshot.blockingDialog };
  }

  if (snapshot.adapter === 'pollev' || snapshot.adapter === 'pollev2') {
    if (!snapshot.scopeFound) return { state: 'unknown', reason: 'this is not a poll page (no activity area found)' };
    if (snapshot.liveTabSelected === false) return { state: 'unknown', reason: 'a tab other than the live activity is selected' };
    if (options.requireSignIn && snapshot.signedIn === false) {
      return { state: 'needs_user', reason: 'signed_out', detail: 'not signed in to Poll Everywhere' };
    }
  }

  const raw = snapshot.poll;
  if (raw === null) {
    if (snapshot.unknownControls > 0) {
      return {
        state: 'unknown',
        reason: `the activity area contains ${snapshot.unknownControls} control(s) this tool does not recognise`,
      };
    }
    return { state: 'waiting' };
  }
  if (raw.incomplete) return { state: 'loading', reason: 'the poll is still being drawn' };

  const poll: Poll = {
    fingerprint: fingerprintOf({
      kind: raw.kind,
      question: raw.kind === 'unsupported' ? `${raw.unsupportedType ?? ''}\n${raw.question}` : raw.question,
      options: raw.options.map((o) => o.label),
      siteId: raw.siteId,
    }),
    siteId: raw.siteId,
    kind: raw.kind,
    unsupportedType: raw.unsupportedType,
    question: raw.question,
    options: raw.options.map((o) => ({ ref: o.ref, label: o.label, disabled: o.disabled, selected: o.selected })),
  };
  const { status, evidence } = pollStatus(snapshot, raw);
  return { state: 'poll', poll, status, evidence, snapshot: raw };
}

/** Same page, ignoring the query string, fragment and a trailing slash. */
export function sameLocation(a: string, b: string): boolean {
  return locationKey(a) === locationKey(b);
}

export function locationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url;
  }
}

const POLL_EVERYWHERE_HOSTS = ['pollev.com', 'pe.app', 'polleverywhere.com'];

function pollEverywhereHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return POLL_EVERYWHERE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Whether two links are the same presenter's page on Poll Everywhere, allowing
 * for the move between its addresses (pollev.com/<name> redirects to
 * pe.app/<name> for presenters on "Poll Everywhere 2.0").
 */
export function samePresenter(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (!pollEverywhereHost(ua.hostname) || !pollEverywhereHost(ub.hostname)) return false;
    const first = (u: URL): string => (u.pathname.split('/').find((part) => part !== '') ?? '').toLowerCase();
    return first(ua) !== '' && first(ua) === first(ub);
  } catch {
    return false;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
