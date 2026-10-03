import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprintOf, normalizeText } from '../../src/recognizer/fingerprint.ts';

const base = { kind: 'multiple_choice' as const, question: 'Closest planet?', options: ['Mercury', 'Venus', 'Earth'] };

test('the same poll always gives the same fingerprint', () => {
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base, options: [...base.options] }));
  assert.match(fingerprintOf(base), /^[0-9a-f]{32}$/);
});

test('the order of the options does not matter', () => {
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base, options: ['Earth', 'Mercury', 'Venus'] }));
});

test('whitespace, letter case and Unicode form do not matter', () => {
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base, question: '  closest   PLANET?\n', options: ['mercury ', ' VENUS', 'Earth'] }));
  // "é" as one code point and as "e" + combining accent.
  assert.equal(
    fingerprintOf({ kind: 'free_text', question: 'Café?', options: [] }),
    fingerprintOf({ kind: 'free_text', question: 'Café?', options: [] }),
  );
  assert.equal(normalizeText('  A  B\tC  '), 'a b c');
});

test('a different question, option, kind or site id gives a different fingerprint', () => {
  const original = fingerprintOf(base);
  assert.notEqual(original, fingerprintOf({ ...base, question: 'Farthest planet?' }));
  assert.notEqual(original, fingerprintOf({ ...base, options: ['Mercury', 'Venus', 'Mars'] }));
  assert.notEqual(original, fingerprintOf({ ...base, options: ['Mercury', 'Venus'] }));
  assert.notEqual(original, fingerprintOf({ ...base, kind: 'free_text' }));
  assert.notEqual(original, fingerprintOf({ ...base, siteId: 'abc' }));
  assert.notEqual(fingerprintOf({ ...base, siteId: 'abc' }), fingerprintOf({ ...base, siteId: 'abd' }));
});

test('a missing site id and a null site id are the same thing', () => {
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base, siteId: null }));
});

test('options that only differ by which text sits where are not confused', () => {
  assert.notEqual(
    fingerprintOf({ kind: 'multiple_choice', question: 'Q', options: ['a b', 'c'] }),
    fingerprintOf({ kind: 'multiple_choice', question: 'Q', options: ['a', 'b c'] }),
  );
  assert.notEqual(
    fingerprintOf({ kind: 'multiple_choice', question: 'Q a', options: ['b'] }),
    fingerprintOf({ kind: 'multiple_choice', question: 'Q', options: ['a', 'b'] }),
  );
});
