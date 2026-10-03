import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

test('strategy "first" selects the first option', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'first' } } }, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'Mercury');
  });
});

test('strategy "last" selects the last option', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'last' } } }, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'Mars');
  });
});

test('strategy "random" selects the option the random source points at', async () => {
  // 0.6 of four options is the third one.
  await withBot({ overrides: { response: { multipleChoice: 'random' } }, rng: () => 0.6 }, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'Earth');
    assert.equal(site.responsesFor(id)[0]?.value, 'Earth');
  });
});

test('strategy "skip" detects the poll and sends nothing', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'skip' } } }, async (h, site) => {
    site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.skipped');
    await delay(500);
    assert.equal(site.attempts.length, 0);
    assert.equal(h.events('poll.skipped').length, 1);
    const summary = await h.stop();
    assert.equal(summary.skipped, 1);
    assert.equal(summary.answered, 0);
  });
});

test('a free-text poll gets the configured fixed text, which defaults to "value"', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Say something' });
    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'value');
    assert.match(String(answered['evidence']), /announced the response was saved/);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.value, 'value');
  });
});

test('free text can be set to another string', async () => {
  await withBot({ overrides: { response: { fixedText: 'here today' } } }, async (h, site) => {
    const id = site.activate({ title: 'Say something' });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'here today');
  });
});

test('free-text strategy "echo_question" sends the question text', async () => {
  await withBot({ overrides: { response: { freeText: 'echo_question' } } }, async (h, site) => {
    const id = site.activate({ title: 'What is the capital of France?' });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'What is the capital of France?');
  });
});

test('a free-text poll that allows several responses still gets exactly one', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'As many as you like', maxVotes: null });
    await h.waitForEvent('poll.answered');
    await delay(1500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('a multiple-choice poll that allows several votes still gets exactly one', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
    await h.waitForEvent('poll.answered');
    await delay(1500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('dry run logs what it would send and sends nothing', async () => {
  await withBot({ overrides: { dryRun: true } }, async (h, site) => {
    site.activate({ title: 'Pick', options: PLANETS });
    const event = await h.waitForEvent('poll.dry_run');
    assert.equal(event['response'], 'Mercury');
    site.activate({ title: 'Words' });
    await h.waitForEvent('poll.dry_run', (e) => e['response'] === 'value');
    await delay(400);
    assert.equal(site.attempts.length, 0);
    assert.equal(site.ledger.length, 0);
    assert.equal(h.events('poll.answered').length, 0);
  });
});

test('the response waits for the configured delay', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 1200, max: 1200 } } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const start = Date.now();
    site.activate({ title: 'Patience', options: PLANETS });
    await h.waitForEvent('poll.answered');
    const first = site.attempts[0];
    assert.ok(first);
    const waited = Date.parse(first.at) - start;
    assert.ok(waited >= 1150, `responded after only ${waited} ms`);
  });
});
