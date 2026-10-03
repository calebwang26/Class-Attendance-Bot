import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

// Behaviours of the real Poll Everywhere page that are uncommon but possible,
// reproduced by the mock, and what the bot must do in each.

test('if the page never reloads your earlier vote, a reload shows the poll open again, but the bot does not vote twice', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.noRestore = true;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.waitForEvent('poll.answered');
      site.forceReload();
      await h.waitForEvent('poll.server_check', undefined, 10000);
      const skipped = await h.waitForEvent('poll.duplicate_skipped', undefined, 20000);
      assert.equal(skipped['reason'], 'unverifiable');
      assert.ok(h.notifications.some((n) => /check this poll/.test(n.title)));
      await delay(1500);
      assert.equal(site.attempts.length, 1, 'no second vote');
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.server_check').length, 1, 'checked once');
    },
  );
});

test('if reloading your earlier vote fails, the bot does not take "open" at face value', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
    await h.waitForEvent('poll.answered');
    site.faults.failResults = true;
    site.forceReload();
    const skipped = await h.waitForEvent('poll.duplicate_skipped', undefined, 20000);
    assert.equal(skipped['reason'], 'unverifiable');
    await delay(1000);
    assert.equal(site.attempts.length, 1);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a re-vote the page fails to show (count missing) is caught by the periodic reload and answered', async () => {
  await withBot(
    {
      overrides: { monitor: { resyncMs: 1500 } },
      before: (site) => {
        site.faults.omitResultsCount = true;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Vote again later', options: PLANETS });
      await h.waitForEvent('poll.answered');
      // The presenter clears responses; this page keeps showing the old vote.
      site.clearResponses();
      await h.until(() => h.events('poll.answered').length === 2, 'the re-vote to be answered', 20000);
      assert.equal(site.responsesFor(id).length, 1, 'one response in the new round');
      assert.equal(site.ledger.length, 2);
    },
  );
});

test('options drawn as equations still loading are not reported or answered until they are drawn', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.equationMs = 900;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Which is larger?', options: ['e^2', 'pi^2'] });
      await h.waitForEvent('poll.answered');
      const detected = h.events('poll.detected');
      assert.equal(detected.length, 1);
      assert.deepEqual(detected[0]?.['options'], ['e^2', 'pi^2']);
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('a hidden title is not taken as the question, and echoing it falls back to the fixed text', async () => {
  await withBot({ overrides: { response: { freeText: 'echo_question' } } }, async (h, site) => {
    const id = site.activate({ title: 'The real question', titleHidden: true });
    const detected = await h.waitForEvent('poll.detected');
    assert.equal(detected['question'], '');
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'value');
  });
});

test('options with identical labels are told apart by position', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'last' } } }, async (h, site) => {
    const id = site.activate({ title: 'Which picture?', options: ['Image option', 'Image option', 'Image option'] });
    const detected = await h.waitForEvent('poll.detected');
    assert.deepEqual(detected['options'], ['Image option (1)', 'Image option (2)', 'Image option (3)']);
    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'Image option (3)');
    assert.equal(site.responsesFor(id)[0]?.optionId, `${id}-o3`);
  });
});

test('a competition question (marked as a multiple-choice poll inside a competition) is answered without the usual delay', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 6000, max: 6000 } } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const start = Date.now();
    const id = site.activate({ title: 'Quick!', type: 'competition', displayState: 'instructions', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 5000);
    assert.ok(Date.now() - start < 4000, `took ${Date.now() - start} ms`);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a full poll ("Poll is full") is not clicked', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Too late', options: PLANETS, state: 'maxed_out' });
    const closed = await h.waitForEvent('poll.closed');
    assert.match(String(closed['evidence']), /Poll is full/);
    await delay(1000);
    assert.equal(site.attempts.length, 0);
  });
});

test('a poll allowing several votes but one per option gets exactly one vote', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick up to three', options: PLANETS, maxVotes: 3, responsesPerOption: 1 });
    const answered = await h.waitForEvent('poll.answered');
    assert.match(String(answered['evidence']), /2 responses remaining\. Each option may only be selected once\./);
    await delay(1500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('a rejected submission that raises no error event is still retried after the confirmation time, once recorded', async () => {
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.errorWithoutKey = true;
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 15000);
      assert.deepEqual(
        site.attempts.map((a) => a.outcome),
        ['failed', 'accepted'],
      );
      assert.equal(site.responsesFor(id).length, 1);
      assert.match(String(h.events('poll.attempt_failed')[0]?.['evidence']), /did not confirm/);
    },
  );
});

test('an option edited while the poll is open keeps working: the bot reads the new text', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'first', delayMs: { min: 900, max: 900 } } } }, async (h, site) => {
    const id = site.activate({ title: 'Typo fixed live', options: ['Mercurry', 'Venus'] });
    await h.waitForEvent('poll.detected');
    site.edit({ options: ['Mercury', 'Venus'] });
    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'Mercury');
    assert.equal(site.responsesFor(id)[0]?.value, 'Mercury');
    assert.equal(site.ledger.length, 1);
  });
});
