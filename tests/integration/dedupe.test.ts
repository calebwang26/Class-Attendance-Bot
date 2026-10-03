import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botParticipant, cleanup, delay, makeScratchDir, PLANETS, startBot, startMockSite, withBot } from '../helpers/harness.ts';

test('reloading the page after answering does not produce a second response or a second detection', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    const loads = site.pageLoads;
    site.forceReload();
    await h.until(() => site.pageLoads > loads, 'the reload');
    await delay(2500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
    assert.equal(h.events('poll.detected').length, 1);
  });
});

test('restarting the bot after answering does not produce a second response', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    const first = await startBot(site, site.participantUrl(), { dir });
    await first.waitForEvent('poll.answered');
    const firstSummary = await first.stop();
    assert.equal(firstSummary.answered, 1);

    const second = await startBot(site, site.participantUrl(), { dir });
    await second.waitForEvent('poll.detected');
    await delay(2500);
    const secondSummary = await second.stop();
    assert.equal(secondSummary.answered, 0);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  } finally {
    await site.close();
    cleanup(dir);
  }
});

test('restarting the bot in the middle of a poll it has not answered yet answers it once', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    const slow = { response: { delayMs: { min: 5000, max: 5000 } } };
    const first = await startBot(site, site.participantUrl(), { dir, overrides: slow });
    await first.waitForEvent('poll.detected');
    await first.stop();
    assert.equal(site.attempts.length, 0);

    const second = await startBot(site, site.participantUrl(), { dir });
    await second.waitForEvent('poll.answered');
    await second.stop();
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  } finally {
    await site.close();
    cleanup(dir);
  }
});

test('a burst of page changes while a poll is showing produces one response', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 600, max: 600 } } } }, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    const page = h.bot.browser.page;
    assert.ok(page);
    // Hundreds of unrelated mutations, spread over the time the bot is deciding and responding.
    await page.evaluate(() => {
      const noise = document.createElement('div');
      noise.id = 'noise';
      document.body.appendChild(noise);
      let n = 0;
      const timer = setInterval(() => {
        for (let i = 0; i < 25; i += 1) {
          noise.setAttribute('data-n', String((n += 1)));
          noise.textContent = `tick ${n}`;
        }
        if (n > 2500) clearInterval(timer);
      }, 10);
    });
    await h.waitForEvent('poll.answered');
    await delay(1500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
    assert.equal(h.events('poll.detected').length, 1);
  });
});

test('a poll answered by hand before the bot acts is left alone and recorded as answered', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 2500, max: 2500 } } } }, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.detected');
    const page = h.bot.browser.page;
    assert.ok(page);
    // The person clicks the third option themselves.
    await page.locator('.component-response-multiple-choice__option__vote').nth(2).click({ force: true });
    const event = await h.waitForEvent('poll.already_answered');
    assert.match(String(event['evidence']), /Earth/);
    await delay(3200);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.value, 'Earth');
    assert.equal(h.events('poll.responding').length, 0);
    const summary = await h.stop();
    assert.equal(summary.alreadyAnswered, 1);
    assert.equal(summary.answered, 0);
  });
});

test('a poll answered on another device is not answered again, even while the page is still loading that response', async () => {
  let id = '';
  await withBot(
    {
      // Earlier responses arrive 1.2 s after the poll is drawn; the settling period is longer than that.
      overrides: { monitor: { settleMs: 2500 } },
      before: (site) => {
        site.faults.resultsDelayMs = 1200;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      id = site.activate({ title: 'Pick', options: PLANETS, id: 'known-poll' });
      // Recorded server-side for this participant, as if sent from a phone. The open page does not know yet.
      site.respondAs(botParticipant(site), id, { optionIndex: 1 });
      site.remount();
      await h.waitForEvent('poll.already_answered', undefined, 8000);
      await delay(1500);
      assert.equal(site.attempts.length, 0, 'the bot must not click while the earlier response is loading');
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.responsesFor(id)[0]?.value, 'Venus');
    },
  );
});

test('when the presenter clears the responses, the poll is answered again (one response per round)', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Vote, discuss, vote again', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
    site.clearResponses();
    await h.until(() => h.events('poll.answered').length === 2, 'the second response', 8000);
    assert.equal(site.responsesFor(id).length, 1, 'one response in the new round');
    assert.equal(site.ledger.length, 2, 'one per round');
    assert.equal(h.events('poll.responding')[1]?.['reason'], 'reopened');
    await delay(1500);
    assert.equal(site.ledger.length, 2);
  });
});

test('a poll shown again without clearing responses is not answered a second time', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    site.deactivate();
    await delay(1200);
    site.reactivate(id);
    await h.until(() => h.events('poll.detected').length === 2, 'the poll to come back');
    await delay(2500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('a poll shown again after its responses were cleared is answered again', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    site.deactivate();
    await delay(1200);
    site.reactivate(id);
    site.clearResponses();
    await h.until(() => h.events('poll.answered').length === 2, 'the second response', 8000);
    assert.equal(h.events('poll.responding')[1]?.['reason'], 'reappeared');
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.ledger.length, 2);
  });
});

test('two different polls with identical wording are both answered', async () => {
  await withBot({}, async (h, site) => {
    const a = site.activate({ title: 'Same words', options: ['Yes', 'No'] });
    await h.waitForEvent('poll.answered');
    const b = site.activate({ title: 'Same words', options: ['Yes', 'No'] });
    await h.until(() => h.events('poll.answered').length === 2, 'the second poll to be answered');
    assert.notEqual(a, b);
    assert.equal(site.responsesFor(a).length, 1);
    assert.equal(site.responsesFor(b).length, 1);
    assert.notEqual(h.events('poll.answered')[0]?.['fingerprint'], h.events('poll.answered')[1]?.['fingerprint']);
  });
});

test('the same poll redrawn by the page is not answered again', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    for (let i = 0; i < 3; i += 1) {
      site.remount();
      await delay(500);
    }
    await delay(1500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('the bot does not click while the page is still fetching earlier responses, even with a short settling period', async () => {
  let id = '';
  await withBot(
    {
      // Settling is far shorter than the 1.5 s the earlier response takes to load.
      overrides: { monitor: { settleMs: 100 } },
      before: (site) => {
        site.faults.resultsDelayMs = 1500;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      id = site.activate({ title: 'Pick', options: PLANETS, id: 'slow-restore' });
      site.respondAs(botParticipant(site), id, { optionIndex: 3 });
      site.remount();
      await h.waitForEvent('poll.already_answered', undefined, 8000);
      await delay(1000);
      assert.equal(site.attempts.length, 0, 'no click while the earlier response was loading');
      assert.equal(site.responsesFor(id)[0]?.value, 'Mars');
      assert.equal(h.events('poll.responding').length, 0);
    },
  );
});

test('a poll with no earlier response is still answered promptly once the fetch completes', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.resultsDelayMs = 700;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      const start = Date.now();
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered');
      assert.equal(site.responsesFor(id).length, 1);
      const first = site.attempts[0];
      assert.ok(first);
      assert.ok(Date.parse(first.at) - start >= 650, 'the click waited for the fetch');
      assert.ok(Date.parse(first.at) - start < 3000, 'and did not wait much longer');
    },
  );
});

test('if the page merely forgets a response that still stands, the bot reloads to check and does not answer twice', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
    await h.waitForEvent('poll.answered');
    const loads = site.pageLoads;
    // The page is told "no responses" although the server still has ours: it shows the poll as open again.
    site.stalePush();
    await h.waitForEvent('poll.server_check', undefined, 8000);
    await h.until(() => site.pageLoads > loads, 'the check reload');
    await delay(2500);
    assert.equal(site.attempts.length, 1, 'no second submission');
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(h.events('poll.answered').length, 1);
    assert.equal(h.events('poll.server_check').length, 1, 'checked once, not in a loop');
  });
});

test('the same holds for a free-text response the page forgets', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Words', maxVotes: null });
    await h.waitForEvent('poll.answered');
    site.stalePush();
    await h.waitForEvent('poll.server_check', undefined, 8000);
    await delay(2500);
    assert.equal(site.attempts.length, 1);
    assert.equal(site.responsesFor(id).length, 1);
  });
});
