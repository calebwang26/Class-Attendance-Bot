import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationKey, pollStatus, recognize, sameLocation, sameOrigin } from '../../src/recognizer/recognize.ts';
import type { PageSnapshot, SnapshotOption, SnapshotPoll } from '../../src/types.ts';

const poll = (over: Partial<SnapshotPoll> = {}): SnapshotPoll => ({
  siteId: 'p1',
  kind: 'multiple_choice',
  siteType: 'multiple_choice_poll',
  unsupportedType: null,
  question: 'Closest planet?',
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
  mountRef: 'm1',
  competition: false,
  ...over,
});

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  agentVersion: 1,
  docStartedAt: 0,
  url: 'https://pollev.com/someone',
  title: 'someone’s presentation',
  readyState: 'complete',
  online: true,
  adapter: 'pollev',
  scopeFound: true,
  pushConnected: true,
  resultsLoaded: false,
  signedIn: true,
  authRequired: false,
  authReason: null,
  blockingDialog: null,
  liveTabSelected: true,
  unknownControls: 0,
  cookieBanner: false,
  signals: { saved: 0, errors: 0, lastError: null },
  poll: null,
  scopeText: '',
  ...over,
});

const opts = (spec: Array<[string, boolean, boolean]>): SnapshotOption[] =>
  spec.map(([label, disabled, selected], i) => ({ ref: `e${i}`, label, disabled, selected }));

const strict = { requireSignIn: true };

test('a document still loading is "loading"', () => {
  assert.deepEqual(recognize(snap({ readyState: 'loading' }), strict), { state: 'loading', reason: 'the document is still loading' });
});

test('the waiting screen is "waiting"', () => {
  assert.deepEqual(recognize(snap(), strict), { state: 'waiting' });
});

test('a sign-in page needs the user, ahead of everything else', () => {
  const r = recognize(snap({ authRequired: true, authReason: 'a password field is showing', poll: poll({ options: opts([['A', false, false]]) }) }), strict);
  assert.deepEqual(r, { state: 'needs_user', reason: 'sign_in', detail: 'a password field is showing' });
});

test('a modal dialog needs the user even while a poll is showing behind it', () => {
  const r = recognize(snap({ blockingDialog: 'Screen name configuration', poll: poll({ options: opts([['A', false, false]]) }) }), strict);
  assert.deepEqual(r, { state: 'needs_user', reason: 'dialog', detail: 'Screen name configuration' });
});

test('signed out on Poll Everywhere needs the user, unless sign-in is not required', () => {
  const s = snap({ signedIn: false, poll: poll({ options: opts([['A', false, false], ['B', false, false]]) }) });
  assert.equal(recognize(s, strict).state, 'needs_user');
  const relaxed = recognize(s, { requireSignIn: false });
  assert.equal(relaxed.state, 'poll');
  // Unknown sign-in state is not treated as signed out.
  assert.equal(recognize(snap({ signedIn: null }), strict).state, 'waiting');
});

test('a Poll Everywhere page without the activity area, or on another tab, is "unknown"', () => {
  assert.equal(recognize(snap({ scopeFound: false }), strict).state, 'unknown');
  assert.equal(recognize(snap({ liveTabSelected: false }), strict).state, 'unknown');
});

test('unrecognised controls in the activity area are "unknown", not "waiting"', () => {
  const r = recognize(snap({ unknownControls: 2 }), strict);
  assert.equal(r.state, 'unknown');
  assert.match(r.state === 'unknown' ? r.reason : '', /2 control/);
});

test('a poll whose controls are not drawn yet is "loading"', () => {
  assert.deepEqual(recognize(snap({ poll: poll({ incomplete: true }) }), strict), { state: 'loading', reason: 'the poll is still being drawn' });
});

test('an open multiple-choice poll', () => {
  const r = recognize(snap({ poll: poll({ statusText: 'You can respond once', options: opts([['Mercury', false, false], ['Venus', false, false]]) }) }), strict);
  assert.equal(r.state, 'poll');
  if (r.state !== 'poll') return;
  assert.equal(r.status, 'open');
  assert.equal(r.poll.kind, 'multiple_choice');
  assert.equal(r.poll.question, 'Closest planet?');
  assert.deepEqual(r.poll.options.map((o) => o.label), ['Mercury', 'Venus']);
  assert.match(r.poll.fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(r.poll.siteId, 'p1');
});

test('Poll Everywhere: an option marked as voted means answered, even when locked afterwards', () => {
  const voted = poll({ statusText: 'Response recorded', answeredMarker: true, options: opts([['Mercury', true, true], ['Venus', true, false]]) });
  assert.equal(pollStatus(snap(), voted).status, 'answered');
  const lockedAfter = poll({ statusText: 'This poll is locked.', closedMarker: true, options: opts([['Mercury', true, true], ['Venus', true, false]]) });
  assert.equal(pollStatus(snap(), lockedAfter).status, 'answered');
  assert.match(pollStatus(snap(), voted).evidence, /Mercury/);
});

test('Poll Everywhere: a voted option on a poll that allows more votes still counts as answered', () => {
  const p = poll({ statusText: 'You have 2 responses remaining', answeredMarker: true, options: opts([['A', false, true], ['B', false, false]]) });
  assert.equal(pollStatus(snap(), p).status, 'answered');
});

test('Poll Everywhere: "Response recorded" with no option marked is still answered', () => {
  const p = poll({ statusText: 'Response recorded', answeredMarker: true, options: opts([['A', true, false], ['B', true, false]]) });
  assert.equal(pollStatus(snap(), p).status, 'answered');
});

test('Poll Everywhere: locked, full, or every option disabled without a vote is closed', () => {
  assert.equal(pollStatus(snap(), poll({ statusText: 'This poll is locked.', closedMarker: true, options: opts([['A', true, false], ['B', true, false]]) })).status, 'closed');
  assert.equal(pollStatus(snap(), poll({ options: opts([['A', true, false], ['B', true, false]]) })).status, 'closed');
  // A locked status wins even if a button were still enabled.
  assert.equal(pollStatus(snap(), poll({ closedMarker: true, options: opts([['A', false, false]]) })).status, 'closed');
});

test('elsewhere, a ticked radio button alone is not an answer', () => {
  const generic = snap({ adapter: 'generic', signedIn: null, pushConnected: null, liveTabSelected: null });
  const ticked = poll({ siteId: null, options: opts([['A', false, true], ['B', false, false]]) });
  assert.equal(pollStatus(generic, ticked).status, 'open');
  assert.equal(pollStatus(generic, poll({ siteId: null, answeredMarker: true, options: opts([['A', true, true], ['B', true, false]]) })).status, 'answered');
  assert.equal(pollStatus(generic, poll({ siteId: null, options: opts([['A', true, true], ['B', true, false]]) })).status, 'answered');
  assert.equal(pollStatus(generic, poll({ siteId: null, options: opts([['A', true, false], ['B', true, false]]) })).status, 'closed');
  assert.equal(pollStatus(generic, poll({ siteId: null, closedMarker: true, options: opts([['A', false, false]]) })).status, 'closed');
});

test('free text: open, answered by a listed response or a marker, closed when the box cannot be used', () => {
  const box = { ref: 't', disabled: false, value: '', maxLength: 8000 };
  const base = { kind: 'free_text' as const, siteType: 'free_text_poll', options: [] };
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: box })).status, 'open');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: box, ownResponses: ['value'] })).status, 'answered');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: { ...box, disabled: true }, ownResponses: ['value'] })).status, 'answered');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: { ...box, disabled: true }, answeredMarker: true })).status, 'answered');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: { ...box, disabled: true } })).status, 'closed');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: null })).status, 'closed');
  assert.equal(pollStatus(snap(), poll({ ...base, textInput: box, closedMarker: true })).status, 'closed');
});

test('an unsupported activity is a poll of kind "unsupported", with its type in the fingerprint', () => {
  const rank = recognize(snap({ poll: poll({ kind: 'unsupported', unsupportedType: 'rank_order', siteType: 'ranking_poll', siteId: null }) }), strict);
  const survey = recognize(snap({ poll: poll({ kind: 'unsupported', unsupportedType: 'survey', siteType: 'survey', siteId: null }) }), strict);
  assert.equal(rank.state, 'poll');
  assert.equal(survey.state, 'poll');
  if (rank.state === 'poll' && survey.state === 'poll') {
    assert.equal(rank.poll.kind, 'unsupported');
    assert.equal(rank.poll.unsupportedType, 'rank_order');
    assert.notEqual(rank.poll.fingerprint, survey.poll.fingerprint);
  }
});

test('the fingerprint does not change when the poll goes from open to answered', () => {
  const open = recognize(snap({ poll: poll({ options: opts([['A', false, false], ['B', false, false]]) }) }), strict);
  const answered = recognize(snap({ poll: poll({ statusText: 'Response recorded', answeredMarker: true, options: opts([['A', true, true], ['B', true, false]]) }) }), strict);
  assert.ok(open.state === 'poll' && answered.state === 'poll');
  if (open.state === 'poll' && answered.state === 'poll') {
    assert.equal(open.poll.fingerprint, answered.poll.fingerprint);
    assert.equal(open.status, 'open');
    assert.equal(answered.status, 'answered');
  }
});

test('location helpers ignore query, fragment, trailing slash and letter case of the host', () => {
  assert.ok(sameLocation('https://pollev.com/someone', 'https://POLLEV.com/someone/?x=1#top'));
  assert.ok(!sameLocation('https://pollev.com/someone', 'https://pollev.com/other'));
  assert.ok(!sameLocation('https://pollev.com/someone', 'http://pollev.com/someone'));
  assert.equal(locationKey('https://pollev.com/A/B/?q=1'), 'https://pollev.com/a/b');
  assert.equal(locationKey('not a url'), 'not a url');
  assert.ok(sameOrigin('https://pollev.com/a', 'https://pollev.com/b?c'));
  assert.ok(!sameOrigin('https://pollev.com/a', 'https://login.school.edu/sso'));
  assert.ok(!sameOrigin('nonsense', 'https://pollev.com/'));
});
