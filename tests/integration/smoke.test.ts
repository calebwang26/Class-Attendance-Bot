import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup, startBot, startMockSite } from '../helpers/harness.ts';

test('answers a multiple-choice poll once and confirms it', async () => {
  const site = await startMockSite();
  const h = await startBot(site, site.participantUrl());
  try {
    const id = site.activate({ title: 'Which planet is closest to the sun?', options: ['Mercury', 'Venus', 'Earth', 'Mars'] });
    const detected = await h.waitForEvent('poll.detected');
    assert.equal(detected['question'], 'Which planet is closest to the sun?');
    assert.deepEqual(detected['options'], ['Mercury', 'Venus', 'Earth', 'Mars']);
    assert.equal(detected['kind'], 'multiple_choice');

    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'Mercury');
    assert.match(String(answered['evidence']), /announced the response was saved/);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.value, 'Mercury');

    const summary = await h.stop();
    assert.equal(summary.detected, 1);
    assert.equal(summary.answered, 1);
    assert.equal(summary.failed, 0);
    assert.equal(site.ledger.length, 1);
  } finally {
    await h.stop().catch(() => undefined);
    await site.close();
    cleanup(h.dir);
  }
});
