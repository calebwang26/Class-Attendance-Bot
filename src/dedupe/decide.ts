import type { PollKind, PollStatus } from '../types.ts';

/** What is known about an earlier response to the same poll. */
export interface PreviousAnswer {
  /** Epoch ms of the earlier response. */
  at: number;
  /**
   * The page displayed that response as recorded. If so, the page can show
   * such responses: when it later shows the poll as open, the response may
   * really be gone (cleared, or the poll is being run again).
   */
  pageShowedAnswered: boolean;
  /**
   * Since that response, the page spent a stable period showing something
   * else (the waiting screen or another poll). The poll being back means the
   * presenter activated it again.
   */
  separated: boolean;
}

/**
 * Checking with the server, by loading the page afresh, whether a poll still
 * wants a response:
 *   unchecked       the page has not been loaded afresh since the doubt arose;
 *   pending         it has, and the fresh page is still fetching earlier responses;
 *   confirmed_open  the fresh page fetched them and still shows the poll open;
 *   unverifiable    the fresh page never fetched them, so its "open" proves nothing.
 */
export type Recheck =
  | { state: 'unchecked' }
  | { state: 'pending'; until: number }
  | { state: 'confirmed_open' }
  | { state: 'unverifiable' };

export interface DecisionInput {
  kind: PollKind;
  status: PollStatus;
  /** Epoch ms. */
  now: number;
  /** Failed attempts so far for this appearance of the poll. */
  failedAttempts: number;
  maxAttempts: number;
  /** Do not try again before this time (back-off after a failure), or null. */
  retryNotBefore: number | null;
  /** A confirmed earlier response to this poll, or null. */
  previous: PreviousAnswer | null;
  /**
   * An attempt on this appearance operated the page but was not confirmed.
   * The response may have reached the server anyway (for example when only
   * the reply was lost).
   */
  unconfirmedAttempt: boolean;
  /** When a poll answered earlier was first seen open again, or null. */
  reopenSeenAt: number | null;
  recheck: Recheck;
  /** How long an answered poll must look open before the page is reloaded to check. */
  reanswerSettleMs: number;
}

export type SkipReason = 'unsupported' | 'answered_on_page' | 'closed' | 'duplicate' | 'unverifiable' | 'gave_up';

export type Decision =
  | { action: 'respond'; reason: 'new' | 'retry' | 'reappeared' | 'reopened' }
  | { action: 'wait'; until: number; reason: 'retry_backoff' | 'reopen_settling' | 'recheck_pending' }
  /** Reload the page so that what it shows comes from the server, then decide again. */
  | { action: 'verify'; reason: 'reopened' | 'unconfirmed_attempt' }
  | { action: 'skip'; reason: SkipReason };

/**
 * The rule that prevents both double responses and missed polls, as a pure
 * function.
 *
 * What the page shows comes first: a poll the page displays as answered is
 * never touched.
 *
 * Whenever a response to this poll may already be on the server, nothing is
 * sent until the page has been loaded afresh and, after fetching the
 * participant's earlier responses from the server, still shows the poll as
 * open. That is the case when:
 *   - an earlier attempt operated the page but was never confirmed (its reply
 *     may have been lost), or
 *   - the poll was answered before, the page showed that response, and the
 *     poll now looks open again (a re-vote, or the page simply lost track).
 *     This first has to hold for a settling period.
 * If the fresh page never fetched earlier responses, its "open" proves
 * nothing, and the poll is left alone (the user is told).
 *
 * A poll answered before on a page that cannot show responses is answered
 * again only if it went away and came back (the page stably showed something
 * else in between).
 */
export function decide(input: DecisionInput): Decision {
  if (input.kind === 'unsupported') return { action: 'skip', reason: 'unsupported' };
  if (input.status === 'answered') return { action: 'skip', reason: 'answered_on_page' };
  if (input.status === 'closed') return { action: 'skip', reason: 'closed' };

  let reason: 'new' | 'retry' | 'reappeared' | 'reopened' = 'new';
  const reopened = input.previous !== null && input.previous.pageShowedAnswered;

  if (input.previous && !reopened) {
    if (!input.previous.separated) return { action: 'skip', reason: 'duplicate' };
    reason = 'reappeared';
  }

  if (input.failedAttempts >= input.maxAttempts) return { action: 'skip', reason: 'gave_up' };
  if (input.retryNotBefore !== null && input.now < input.retryNotBefore) {
    return { action: 'wait', until: input.retryNotBefore, reason: 'retry_backoff' };
  }

  if (reopened || input.unconfirmedAttempt) {
    switch (input.recheck.state) {
      case 'unchecked': {
        if (input.unconfirmedAttempt) return { action: 'verify', reason: 'unconfirmed_attempt' };
        const checkAt = (input.reopenSeenAt ?? input.now) + input.reanswerSettleMs;
        if (input.now < checkAt) return { action: 'wait', until: checkAt, reason: 'reopen_settling' };
        return { action: 'verify', reason: 'reopened' };
      }
      case 'pending':
        return { action: 'wait', until: input.recheck.until, reason: 'recheck_pending' };
      case 'unverifiable':
        return { action: 'skip', reason: 'unverifiable' };
      case 'confirmed_open':
        if (reopened) reason = input.previous?.separated ? 'reappeared' : 'reopened';
        break;
    }
  }

  if (input.failedAttempts > 0) reason = 'retry';
  return { action: 'respond', reason };
}
