import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { chooseResponse } from '../../src/selector/select.ts';
import type { Poll, SnapshotPoll } from '../../src/types.ts';

const settings = (over: Partial<typeof DEFAULT_CONFIG.response> = {}) => ({ ...DEFAULT_CONFIG.response, ...over });

function multipleChoice(labels: string[], disabled: number[] = []): { poll: Poll; snapshot: SnapshotPoll } {
  const options = labels.map((label, i) => ({ ref: `e${i + 1}`, label, disabled: disabled.includes(i), selected: false }));
  const snapshot: SnapshotPoll = {
    siteId: null,
    kind: 'multiple_choice',
    siteType: 'multiple_choice_poll',
    unsupportedType: null,
    question: 'Pick one',
    options,
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
  };
  return { poll: { fingerprint: 'f', siteId: null, kind: 'multiple_choice', unsupportedType: null, question: 'Pick one', options }, snapshot };
}

function freeText(question: string, input: SnapshotPoll['textInput']): { poll: Poll; snapshot: SnapshotPoll } {
  const { snapshot } = multipleChoice([]);
  const text: SnapshotPoll = { ...snapshot, kind: 'free_text', siteType: 'free_text_poll', question, options: [], textInput: input };
  return { poll: { fingerprint: 'f', siteId: null, kind: 'free_text', unsupportedType: null, question, options: [] }, snapshot: text };
}

test('"first" and "last" pick the ends', () => {
  const { poll, snapshot } = multipleChoice(['A', 'B', 'C', 'D']);
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ multipleChoice: 'first' })), { kind: 'choice', ref: 'e1', label: 'A' });
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ multipleChoice: 'last' })), { kind: 'choice', ref: 'e4', label: 'D' });
});

test('"random" follows the random source across the whole range', () => {
  const { poll, snapshot } = multipleChoice(['A', 'B', 'C', 'D']);
  const pick = (r: number): string => {
    const plan = chooseResponse(poll, snapshot, settings({ multipleChoice: 'random' }), () => r);
    assert.equal(plan.kind, 'choice');
    return plan.kind === 'choice' ? plan.label : '';
  };
  assert.equal(pick(0), 'A');
  assert.equal(pick(0.2499), 'A');
  assert.equal(pick(0.25), 'B');
  assert.equal(pick(0.6), 'C');
  assert.equal(pick(0.9999), 'D');
  // A faulty source returning exactly 1 must not run off the end.
  assert.equal(pick(1), 'D');
});

test('"random" with the real generator always returns one of the options', () => {
  const { poll, snapshot } = multipleChoice(['A', 'B', 'C']);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i += 1) {
    const plan = chooseResponse(poll, snapshot, settings({ multipleChoice: 'random' }));
    assert.equal(plan.kind, 'choice');
    if (plan.kind === 'choice') seen.add(plan.label);
  }
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C']);
});

test('options that cannot be selected are never chosen', () => {
  const { poll, snapshot } = multipleChoice(['A', 'B', 'C', 'D'], [0, 3]);
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ multipleChoice: 'first' })), { kind: 'choice', ref: 'e2', label: 'B' });
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ multipleChoice: 'last' })), { kind: 'choice', ref: 'e3', label: 'C' });
  for (const r of [0, 0.49, 0.5, 0.99]) {
    const plan = chooseResponse(poll, snapshot, settings({ multipleChoice: 'random' }), () => r);
    assert.ok(plan.kind === 'choice' && ['B', 'C'].includes(plan.label));
  }
});

test('with nothing selectable, or the strategy "skip", it skips with a reason', () => {
  const none = multipleChoice(['A', 'B'], [0, 1]);
  assert.deepEqual(chooseResponse(none.poll, none.snapshot, settings()), { kind: 'skip', reason: 'no option can be selected' });
  const empty = multipleChoice([]);
  assert.equal(chooseResponse(empty.poll, empty.snapshot, settings()).kind, 'skip');
  const some = multipleChoice(['A', 'B']);
  assert.deepEqual(chooseResponse(some.poll, some.snapshot, settings({ multipleChoice: 'skip' })), {
    kind: 'skip',
    reason: 'multiple-choice strategy is "skip"',
  });
});

test('free text sends the fixed text, which is "value" by default', () => {
  const { poll, snapshot } = freeText('Thoughts?', { ref: 't', disabled: false, value: '', maxLength: 8000 });
  assert.deepEqual(chooseResponse(poll, snapshot, settings()), { kind: 'text', value: 'value' });
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ fixedText: '  here   today ' })), { kind: 'text', value: 'here today' });
});

test('echoing a hidden (empty) question sends the fixed text instead', () => {
  const { poll, snapshot } = freeText('   ', { ref: 't', disabled: false, value: '', maxLength: null });
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ freeText: 'echo_question' })), { kind: 'text', value: 'value' });
});

test('free text can echo the question, flattened to one line', () => {
  const { poll, snapshot } = freeText('What is\n the capital   of France?', { ref: 't', disabled: false, value: '', maxLength: null });
  assert.deepEqual(chooseResponse(poll, snapshot, settings({ freeText: 'echo_question' })), {
    kind: 'text',
    value: 'What is the capital of France?',
  });
});

test('free text is cut to the box\'s length limit', () => {
  const { poll, snapshot } = freeText('A long question that will not fit', { ref: 't', disabled: false, value: '', maxLength: 10 });
  const plan = chooseResponse(poll, snapshot, settings({ freeText: 'echo_question' }));
  assert.deepEqual(plan, { kind: 'text', value: 'A long que' });
});

test('free text skips when there is no usable box, nothing to send, or the strategy says so', () => {
  const missing = freeText('Q', null);
  assert.equal(chooseResponse(missing.poll, missing.snapshot, settings()).kind, 'skip');
  const disabled = freeText('Q', { ref: 't', disabled: true, value: '', maxLength: null });
  assert.deepEqual(chooseResponse(disabled.poll, disabled.snapshot, settings()), { kind: 'skip', reason: 'the text box is not available' });
  const fine0 = freeText('Q', { ref: 't', disabled: false, value: '', maxLength: 3 });
  assert.deepEqual(chooseResponse(fine0.poll, fine0.snapshot, settings({ fixedText: ' x ' })), { kind: 'text', value: 'x' });
  const fine = freeText('Q', { ref: 't', disabled: false, value: '', maxLength: null });
  assert.equal(chooseResponse(fine.poll, fine.snapshot, settings({ freeText: 'skip' })).kind, 'skip');
});

test('an unsupported activity is skipped and named', () => {
  const { snapshot } = multipleChoice([]);
  const poll: Poll = { fingerprint: 'f', siteId: null, kind: 'unsupported', unsupportedType: 'rank_order', question: 'Rank', options: [] };
  assert.deepEqual(chooseResponse(poll, { ...snapshot, kind: 'unsupported' }, settings()), {
    kind: 'skip',
    reason: 'unsupported poll type (rank_order)',
  });
});
