import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type DecisionInput } from '../../src/dedupe/decide.ts';

const NOW = 1_000_000;
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  kind: 'multiple_choice',
  status: 'open',
  now: NOW,
  failedAttempts: 0,
  maxAttempts: 3,
  retryNotBefore: null,
  previous: null,
  unconfirmedAttempt: false,
  reopenSeenAt: null,
  recheck: { state: 'unchecked' },
  reanswerSettleMs: 3000,
  ...over,
});

test('a new open poll is answered', () => {
  assert.deepEqual(decide(input()), { action: 'respond', reason: 'new' });
  assert.deepEqual(decide(input({ kind: 'free_text' })), { action: 'respond', reason: 'new' });
});

test('an unsupported activity is never answered, whatever else is true', () => {
  assert.deepEqual(decide(input({ kind: 'unsupported' })), { action: 'skip', reason: 'unsupported' });
  assert.deepEqual(decide(input({ kind: 'unsupported', status: 'answered' })), { action: 'skip', reason: 'unsupported' });
});

test('a poll the page shows as answered is never touched', () => {
  assert.deepEqual(decide(input({ status: 'answered' })), { action: 'skip', reason: 'answered_on_page' });
  assert.deepEqual(
    decide(input({ status: 'answered', previous: { at: NOW - 60000, pageShowedAnswered: true, separated: true } })),
    { action: 'skip', reason: 'answered_on_page' },
  );
});

test('a closed poll is not answered', () => {
  assert.deepEqual(decide(input({ status: 'closed' })), { action: 'skip', reason: 'closed' });
});

test('after a failed attempt, the next one waits for the backoff and is labelled a retry', () => {
  assert.deepEqual(decide(input({ failedAttempts: 1, retryNotBefore: NOW + 300 })), {
    action: 'wait',
    until: NOW + 300,
    reason: 'retry_backoff',
  });
  assert.deepEqual(decide(input({ failedAttempts: 1, retryNotBefore: NOW })), { action: 'respond', reason: 'retry' });
  assert.deepEqual(decide(input({ failedAttempts: 2, retryNotBefore: NOW - 1 })), { action: 'respond', reason: 'retry' });
});

test('once the attempt limit is reached it gives up', () => {
  assert.deepEqual(decide(input({ failedAttempts: 3 })), { action: 'skip', reason: 'gave_up' });
  assert.deepEqual(decide(input({ failedAttempts: 4, retryNotBefore: NOW - 1 })), { action: 'skip', reason: 'gave_up' });
});

test('answered before, page shows such responses: open again first settles, then the page is reloaded to check', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: false };
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 1000 })), {
    action: 'wait',
    until: NOW + 2000,
    reason: 'reopen_settling',
  });
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 3000 })), { action: 'verify', reason: 'reopened' });
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 9000 })), { action: 'verify', reason: 'reopened' });
});

test('after the reload the bot waits for the fresh page to fetch earlier responses, and gives up if it never does', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: false };
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 4000, recheck: { state: 'pending', until: NOW + 2500 } })), {
    action: 'wait',
    until: NOW + 2500,
    reason: 'recheck_pending',
  });
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 9000, recheck: { state: 'unverifiable' } })), {
    action: 'skip',
    reason: 'unverifiable',
  });
});

test('only a freshly loaded page that still shows the poll open leads to a second response', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: false };
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 4000, recheck: { state: 'confirmed_open' as const } })), {
    action: 'respond',
    reason: 'reopened',
  });
  // Even right after the reload: the caller's own settling rules apply from there.
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 100, recheck: { state: 'confirmed_open' as const } })), {
    action: 'respond',
    reason: 'reopened',
  });
});

test('answered before and since replaced by something else: checked the same way, then counts as asked again', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: true };
  assert.equal(decide(input({ previous, reopenSeenAt: NOW - 100 })).action, 'wait');
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 5000 })), { action: 'verify', reason: 'reopened' });
  assert.deepEqual(decide(input({ previous, reopenSeenAt: NOW - 5000, recheck: { state: 'confirmed_open' as const } })), {
    action: 'respond',
    reason: 'reappeared',
  });
});

test('a missing reopen time starts the settling period now', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: false };
  assert.deepEqual(decide(input({ previous, reopenSeenAt: null })), {
    action: 'wait',
    until: NOW + 3000,
    reason: 'reopen_settling',
  });
});

test('answered before on a page that cannot show it: a duplicate unless the poll went away and came back', () => {
  assert.deepEqual(decide(input({ previous: { at: NOW - 60000, pageShowedAnswered: false, separated: false } })), {
    action: 'skip',
    reason: 'duplicate',
  });
  assert.deepEqual(decide(input({ previous: { at: NOW - 60000, pageShowedAnswered: false, separated: true } })), {
    action: 'respond',
    reason: 'reappeared',
  });
});

test('a re-answer that fails is retried under the same limits, without reloading again', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: false };
  const verified = { previous, reopenSeenAt: NOW - 20000, recheck: { state: 'confirmed_open' as const } };
  assert.deepEqual(decide(input({ ...verified, failedAttempts: 1, retryNotBefore: NOW + 50 })), {
    action: 'wait',
    until: NOW + 50,
    reason: 'retry_backoff',
  });
  assert.deepEqual(decide(input({ ...verified, failedAttempts: 1 })), { action: 'respond', reason: 'retry' });
  assert.deepEqual(decide(input({ ...verified, failedAttempts: 3 })), { action: 'skip', reason: 'gave_up' });
});

test('a settling period of zero goes straight to the reload check', () => {
  const previous = { at: NOW - 1, pageShowedAnswered: true, separated: false };
  assert.deepEqual(decide(input({ previous, reanswerSettleMs: 0, reopenSeenAt: NOW })), { action: 'verify', reason: 'reopened' });
});

test('an answered or closed poll is never reloaded for, whatever the history', () => {
  const previous = { at: NOW - 60000, pageShowedAnswered: true, separated: true };
  assert.equal(decide(input({ previous, status: 'answered', reopenSeenAt: NOW - 9000 })).action, 'skip');
  assert.equal(decide(input({ previous, status: 'closed', reopenSeenAt: NOW - 9000 })).action, 'skip');
});

test('after an attempt that may have reached the server, nothing is sent until a fresh page confirms the poll is open', () => {
  const doubt = { unconfirmedAttempt: true, failedAttempts: 1 };
  // The back-off comes first.
  assert.deepEqual(decide(input({ ...doubt, retryNotBefore: NOW + 400 })), { action: 'wait', until: NOW + 400, reason: 'retry_backoff' });
  // Then a reload, at once (no settling period for this case).
  assert.deepEqual(decide(input({ ...doubt })), { action: 'verify', reason: 'unconfirmed_attempt' });
  assert.deepEqual(decide(input({ ...doubt, recheck: { state: 'pending', until: NOW + 900 } })), {
    action: 'wait',
    until: NOW + 900,
    reason: 'recheck_pending',
  });
  assert.deepEqual(decide(input({ ...doubt, recheck: { state: 'confirmed_open' } })), { action: 'respond', reason: 'retry' });
  assert.deepEqual(decide(input({ ...doubt, recheck: { state: 'unverifiable' } })), { action: 'skip', reason: 'unverifiable' });
  // If the fresh page shows the poll answered, the attempt got through: nothing to do.
  assert.deepEqual(decide(input({ ...doubt, status: 'answered' })), { action: 'skip', reason: 'answered_on_page' });
});

test('a failed attempt that sent nothing is retried without a reload', () => {
  assert.deepEqual(decide(input({ failedAttempts: 1, unconfirmedAttempt: false })), { action: 'respond', reason: 'retry' });
});

test('the attempt limit applies before any reload is asked for', () => {
  assert.deepEqual(decide(input({ unconfirmedAttempt: true, failedAttempts: 3 })), { action: 'skip', reason: 'gave_up' });
});
