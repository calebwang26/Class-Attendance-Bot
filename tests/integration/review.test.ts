import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

// Scenarios found in an independent review of the control logic. Each was
// reproduced against the bot before the fix; these tests keep them fixed.

test('a lost reply on a multi-response poll: the bot checks with the server and does not vote twice', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.dropReplies = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.waitForEvent('poll.answered', undefined, 15000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1, 'one vote on the server');
      assert.equal(site.attempts.length, 1, 'one submission');
      assert.ok(h.events('poll.server_check').length >= 1, 'it checked with the server');
      assert.equal(h.events('poll.answered')[0]?.['late'], true);
      const summary = await h.stop();
      assert.equal(summary.answered, 1);
      assert.equal(summary.failed, 0);
    },
  );
});

test('a lost reply on a single-vote poll: no false "could not answer", no second submission', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.dropReplies = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick one', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 15000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
      assert.equal(h.events('poll.failed').length, 0);
      assert.ok(!h.notifications.some((n) => /not answered/.test(n.title)));
    },
  );
});

test('a reply lost because the network dropped: after it returns, the server is checked before anything is resent', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.dropReplies = 1;
      },
    },
    async (h, site) => {
      const page = h.bot.browser.page;
      assert.ok(page);
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.until(() => site.attempts.length >= 1, 'the first submission');
      await page.context().setOffline(true);
      await delay(2000);
      await page.context().setOffline(false);
      await h.waitForEvent('poll.answered', undefined, 20000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('a poll activated while the page is reloading is still caught (missed pushes are replayed)', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    let id = '';
    site.onRender = () => {
      site.onRender = null;
      // The page has been rendered without the poll and is not connected yet.
      id = site.activate({ title: 'Sneaky timing', options: PLANETS });
    };
    site.forceReload();
    await h.waitForEvent('poll.answered', undefined, 8000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('without replay, a poll activated during a reload is caught by the next periodic reload', async () => {
  await withBot(
    {
      overrides: { monitor: { resyncMs: 2500 } },
      before: (site) => {
        site.faults.noReplay = true;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      let id = '';
      site.onRender = () => {
        site.onRender = null;
        id = site.activate({ title: 'Sneaky timing', options: PLANETS });
      };
      site.forceReload();
      await h.waitForEvent('poll.answered', undefined, 15000);
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('a redraw while typing a free-text answer does not make the bot give up', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.skeletonMs = 600;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      const page = h.bot.browser.page;
      assert.ok(page);
      // When the bot types, the presenter side redraws the poll.
      await page.evaluate(() => {
        let fired = false;
        document.addEventListener(
          'input',
          () => {
            if (fired) return;
            fired = true;
            void fetch('/control/remount', { method: 'POST', body: '{}' });
          },
          true,
        );
      });
      const id = site.activate({ title: 'Words please', maxVotes: null });
      await h.waitForEvent('poll.answered', undefined, 20000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.failed').length, 0);
    },
  );
});

test('an outage while the computer still reports a connection: no attempts wasted, answered once it is over', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    const context = page.context();
    const id = site.activate({ title: 'During a silent outage', options: PLANETS });
    await h.waitForEvent('poll.detected');
    await context.route('**/*', (route) => route.abort('connectionreset'));
    await delay(6000);
    await context.unroute('**/*');
    await h.waitForEvent('poll.answered', undefined, 20000);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(h.events('poll.failed').length, 0);
  });
});

test('a vote that the page shows but the server takes too long on is not counted until the server is checked', async () => {
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.submitDelayMs = 3000;
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Slow then failing', options: PLANETS });
      site.faults.submitDelayMs = 3000;
      await h.until(() => site.responsesFor(id).length === 1, 'the response to be recorded in the end', 30000);
      await delay(1000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.answered').length, 1, 'counted once');
      const summary = await h.stop();
      assert.equal(summary.answered, 1);
    },
  );
});

test('after giving up, a vote the user makes by hand is not claimed as the bot\'s', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.failSubmits = 50;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.failed', undefined, 30000);
      site.faults.failSubmits = 0;
      const page = h.bot.browser.page;
      assert.ok(page);
      await page.locator('.component-response-multiple-choice__option__vote').nth(2).click({ force: true });
      await h.waitForEvent('poll.already_answered', undefined, 8000);
      assert.equal(site.responsesFor(id)[0]?.value, 'Earth');
      assert.equal(h.events('poll.answered').length, 0);
      const summary = await h.stop();
      assert.equal(summary.answered, 0);
      assert.equal(summary.failed, 1);
      assert.equal(summary.alreadyAnswered, 1);
    },
  );
});

test('element references differ after a reload, so the settling period starts over', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'skip' } } }, async (h, site) => {
    site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.skipped');
    const before = await h.bot.browser.snapshot();
    const loads = site.pageLoads;
    site.forceReload();
    await h.until(() => site.pageLoads > loads, 'the reload');
    await delay(1000);
    const after = await h.bot.browser.snapshot();
    assert.ok(before.ok && after.ok);
    if (before.ok && after.ok) {
      assert.ok(before.snapshot.poll?.mountRef);
      assert.ok(after.snapshot.poll?.mountRef);
      assert.notEqual(before.snapshot.poll?.mountRef, after.snapshot.poll?.mountRef);
      assert.ok(after.snapshot.docStartedAt > before.snapshot.docStartedAt);
    }
  });
});
