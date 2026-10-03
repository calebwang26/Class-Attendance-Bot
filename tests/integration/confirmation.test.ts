import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

test('a successful response is confirmed with evidence from the page', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Pick', options: PLANETS });
    const answered = await h.waitForEvent('poll.answered');
    assert.match(String(answered['evidence']), /announced the response was saved/);
    assert.match(String(answered['evidence']), /Response recorded/);
    assert.equal(site.ledger.length, 1);
  });
});

test('a submission the server fails once is retried, giving exactly one recorded response', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      const answered = await h.waitForEvent('poll.answered');
      assert.equal(answered['attempt'], 2);
      assert.equal(h.events('poll.attempt_failed').length, 1);
      assert.match(String(h.events('poll.attempt_failed')[0]?.['evidence']), /page reported an error/);
      assert.deepEqual(
        site.attempts.map((a) => a.outcome),
        ['failed', 'accepted'],
      );
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('a free-text submission the server fails once is retried, giving exactly one recorded response', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Words' });
      await h.waitForEvent('poll.answered');
      assert.deepEqual(
        site.attempts.map((a) => a.outcome),
        ['failed', 'accepted'],
      );
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.responsesFor(id)[0]?.value, 'value');
    },
  );
});

test('after the attempt limit the poll is marked failed, the user is told, and no more attempts are made', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.failSubmits = 50;
      },
    },
    async (h, site) => {
      site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.failed', undefined, 15000);
      assert.equal(site.attempts.length, 3);
      await delay(1500);
      assert.equal(site.attempts.length, 3, 'no attempts after giving up');
      assert.equal(site.ledger.length, 0);
      assert.ok(h.notifications.some((n) => /not answered/.test(n.title)));
      const summary = await h.stop();
      assert.equal(summary.failed, 1);
      assert.equal(summary.answered, 0);
    },
  );
});

test('a slow server reply is waited for: one response, no retry', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.submitDelayMs = 2500;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 12000);
      await delay(800);
      assert.equal(site.attempts.length, 1);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.attempt_failed').length, 0);
    },
  );
});

test('a reply slower than the confirmation time still ends with one response and no second click', async () => {
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.submitDelayMs = 3000;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 12000);
      await delay(3500);
      assert.equal(site.attempts.length, 1);
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('a response that the page first shows and the server then rejects is answered again', async () => {
  // The page draws the vote at once; the failure arrives after the bot stopped waiting.
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1200 } },
      before: (site) => {
        site.faults.submitDelayMs = 2000;
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.until(() => site.responsesFor(id).length === 1, 'the response to be recorded in the end', 20000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.deepEqual(
        site.attempts.map((a) => a.outcome),
        ['failed', 'accepted'],
      );
    },
  );
});

test('if the poll goes away after the click but before confirmation, the bot reports it and does not loop', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.submitDelayMs = 3000;
      },
    },
    async (h, site) => {
      site.activate({ title: 'Pick', options: PLANETS });
      const page = h.bot.browser.page;
      assert.ok(page);
      await page.waitForSelector('[data-vote-count]', { timeout: 8000 });
      site.deactivate();
      const failed = await h.waitForEvent('poll.failed', undefined, 12000);
      assert.match(String(failed['evidence']), /went away before the response was confirmed/);
      await delay(800);
      assert.equal(h.events('poll.responding').length, 1);
    },
  );
});

test('if the poll goes away between detection and the click, nothing is clicked and nothing loops', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 900, max: 900 } } } }, async (h, site) => {
    site.activate({ title: 'Blink and it is gone', options: PLANETS });
    await h.waitForEvent('poll.detected');
    site.deactivate();
    await delay(1800);
    assert.equal(site.attempts.length, 0);
    assert.equal(h.events('poll.responding').length, 0);
    assert.equal(h.events('poll.failed').length, 0);
    // And the bot is still working.
    const id = site.activate({ title: 'Next', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});
