/**
 * Shared data types. `PageSnapshot` is what the in-page agent reports;
 * everything else is derived from it on the Node side.
 */

export type PollKind = 'multiple_choice' | 'free_text' | 'unsupported';

/** Which in-page extractor produced the snapshot. */
/**
 * pollev: the Poll Everywhere participant page at pollev.com.
 * pollev2: "Poll Everywhere 2.0" at pe.app, which some presenters' links redirect to.
 * generic: any other page with ordinary form controls.
 */
export type AdapterName = 'pollev' | 'pollev2' | 'generic';

export interface SnapshotOption {
  /** Handle for resolving the clickable element inside the page. */
  ref: string;
  label: string;
  disabled: boolean;
  /** The page shows this option as chosen by the participant. */
  selected: boolean;
}

export interface SnapshotTextInput {
  ref: string;
  disabled: boolean;
  value: string;
  maxLength: number | null;
}

export interface SnapshotSubmit {
  ref: string;
  disabled: boolean;
  label: string;
}

export interface SnapshotPoll {
  /** The site's own identifier for the poll, when the page exposes one. */
  siteId: string | null;
  kind: PollKind;
  /** The site's name for the activity type, e.g. "multiple_choice_poll". */
  siteType: string | null;
  /** For kind "unsupported": what the page appears to be showing. */
  unsupportedType: string | null;
  question: string;
  options: SnapshotOption[];
  textInput: SnapshotTextInput | null;
  submit: SnapshotSubmit | null;
  /** Free text: the participant's own responses listed on the page. */
  ownResponses: string[];
  /**
   * How many of the participant's responses the page's own records hold as
   * saved by the server (not merely drawn on screen). null when the page does
   * not expose this.
   */
  savedResponses: number | null;
  /** How many of the participant's responses the page is still waiting for the server on. null = not exposed. */
  pendingResponses: number | null;
  /** The page explicitly says a response was recorded. */
  answeredMarker: boolean;
  /** The page explicitly says the poll is closed, locked or full. */
  closedMarker: boolean;
  /** Status line shown with the poll, if any. */
  statusText: string;
  /** The poll's controls have not finished rendering. */
  incomplete: boolean;
  /**
   * Identifies the element the poll is drawn in. It changes when the page
   * rebuilds the poll, which on Poll Everywhere restarts the short period in
   * which earlier responses have not been loaded yet.
   */
  mountRef: string | null;
  /** The poll is a question inside a competition, where speed counts. */
  competition: boolean;
}

/** Counters of events the page itself raised since it loaded. */
export interface PageSignals {
  /** Times the page announced that a response was saved by the server. */
  saved: number;
  /** Times the page announced an error. */
  errors: number;
  lastError: string | null;
}

export interface PageSnapshot {
  agentVersion: number;
  /**
   * When the current document started loading (epoch ms, the page's
   * performance.timeOrigin). It changes only when the page is loaded afresh.
   */
  docStartedAt: number;
  url: string;
  title: string;
  readyState: string;
  online: boolean;
  adapter: AdapterName;
  /** The element that holds the live activity was found. */
  scopeFound: boolean;
  /** State of the page's push connection, when the page exposes it. null = unknown. */
  pushConnected: boolean | null;
  /**
   * This document has successfully fetched the participant's earlier responses
   * (a request to an address ending in /results answered with a 2xx status).
   * Only then does a poll it shows as open reflect the server.
   */
  resultsLoaded: boolean;
  /** Whether the participant is signed in, when the page shows it. null = unknown. */
  signedIn: boolean | null;
  /** A sign-in or registration page is in the way. */
  authRequired: boolean;
  authReason: string | null;
  /** Label of a modal dialog that is covering the page, if any. */
  blockingDialog: string | null;
  /** Poll Everywhere's location check-in, as the page shows it. */
  checkIn: CheckInState;
  /** False when the page is showing some other tab than the live activity. null = not applicable. */
  liveTabSelected: boolean | null;
  /** Interactive controls in the activity area that the extractor did not recognise. */
  unknownControls: number;
  /** A cookie notice is showing. It may cover part of the poll. */
  cookieBanner: boolean;
  signals: PageSignals;
  poll: SnapshotPoll | null;
  /** Visible text of the activity area, truncated. Diagnostics only. */
  scopeText: string;
}

export interface CheckInState {
  /** The check-in panel ("The presenter has requested you check in ...") is showing. */
  showing: boolean;
  /** The panel's one "Check in" button, if it is there. */
  buttonRef: string | null;
  /** The page says "We were unable to check you in." */
  failed: boolean;
}

export interface PollOption {
  ref: string;
  label: string;
  disabled: boolean;
  selected: boolean;
}

export interface Poll {
  fingerprint: string;
  siteId: string | null;
  kind: PollKind;
  unsupportedType: string | null;
  question: string;
  options: PollOption[];
}

/** open: can be answered now. answered: the page shows our response. closed: visible but not answerable. */
export type PollStatus = 'open' | 'answered' | 'closed';

export type Recognition =
  | { state: 'loading'; reason: string }
  | { state: 'waiting' }
  | { state: 'needs_user'; reason: 'sign_in' | 'dialog' | 'signed_out'; detail: string }
  | { state: 'check_in'; buttonRef: string }
  | { state: 'unknown'; reason: string }
  | { state: 'poll'; poll: Poll; status: PollStatus; evidence: string; snapshot: SnapshotPoll };

export type PlannedResponse =
  | { kind: 'choice'; ref: string; label: string }
  | { kind: 'text'; value: string }
  | { kind: 'skip'; reason: string };

export interface Confirmation {
  ok: boolean;
  /** What on the page showed the response was accepted (or why it was not). */
  evidence: string;
  /** The page went on to display the poll as answered. */
  pageShowsAnswered: boolean;
  /** The poll was no longer on the page when the attempt ended, so retrying is pointless. */
  pollGone: boolean;
  /** A control was operated, so a response may have been sent even if it was not confirmed. */
  sent: boolean;
}
