import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockSite } from '../../mock-site/server.ts';
import { cleanup, delay, PLANETS, startBot, withBot } from '../helpers/harness.ts';

test('after the page reloads itself, the next poll is still detected and answered', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const loads = site.pageLoads;
    site.forceReload();
    await h.until(() => site.pageLoads > loads, 'the reload');
    await delay(300);
    const id = site.activate({ title: 'After reload', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('when the page navigates to another address, the bot returns to the poll link', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    site.redirect('/elsewhere');
    const started = await h.waitForEvent('recovery.start');
    assert.match(String(started['reason']), /instead of the poll link/);
    await h.waitForEvent('recovery.ok');
    const id = site.activate({ title: 'Back again', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
    const summary = await h.stop();
    assert.ok(summary.recoveries >= 1);
  });
});

test('a crashed tab is replaced and monitoring resumes', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    void page.goto('chrome://crash').catch(() => undefined);
    await h.waitForEvent('page.crash', undefined, 15000);
    await h.waitForEvent('recovery.ok', undefined, 15000);
    const id = site.activate({ title: 'After the crash', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a page that stops responding is replaced and monitoring resumes', async () => {
  await withBot({ overrides: { monitor: { snapshotTimeoutMs: 600 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    // Lock up the page's main thread.
    void page.evaluate(() => {
      for (;;) {
        // spin
      }
    }).catch(() => undefined);
    const started = await h.waitForEvent('recovery.start', undefined, 20000);
    assert.match(String(started['reason']), /stopped responding/);
    await h.waitForEvent('recovery.ok', undefined, 30000);
    const id = site.activate({ title: 'After the hang', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 15000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test("closing the bot's browser tab stops the bot", async () => {
  await withBot({}, async (h) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    await page.close();
    await h.until(() => h.bot.currentState === 'STOPPED', 'the bot to stop', 8000);
    const summary = await h.stop();
    assert.match(summary.stopReason, /browser tab was closed/);
  });
});

test('a network outage is noticed, and a poll activated during it is answered once the network returns', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    await page.context().setOffline(true);
    await h.waitForEvent('network.offline', undefined, 8000);
    const id = site.activate({ title: 'During the outage', options: PLANETS });
    await delay(1200);
    await page.context().setOffline(false);
    await h.waitForEvent('network.online', undefined, 8000);
    await h.waitForEvent('poll.answered', undefined, 15000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a push channel that silently stops delivering is covered by the periodic reload', async () => {
  await withBot({ overrides: { monitor: { resyncMs: 1200 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    site.faults.pushSilent = true;
    const id = site.activate({ title: 'Nobody was told', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 10000);
    assert.equal(site.responsesFor(id).length, 1);
    // Routine reloads are not counted as faults.
    assert.equal(h.events('recovery.start').length, 0);
  });
});

test('no periodic reload happens while a response is still owed', async () => {
  await withBot({ overrides: { monitor: { resyncMs: 500 }, response: { delayMs: { min: 2500, max: 2500 } } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const id = site.activate({ title: 'Do not reload me away', options: PLANETS });
    await h.waitForEvent('poll.detected');
    const loads = site.pageLoads;
    await h.waitForEvent('poll.answered', undefined, 10000);
    // The poll was showing, unanswered, for 2.5 s; a 0.5 s reload cycle must have been held off.
    const responding = h.events('poll.responding')[0];
    assert.ok(responding);
    const reloadsBeforeAnswer = h.logger.events.filter((e) => e.event === 'reload.planned' && e.ts > String(h.events('poll.detected')[0]?.ts) && e.ts < responding.ts);
    assert.equal(reloadsBeforeAnswer.length, 0);
    assert.ok(site.pageLoads >= loads);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a push connection that stays down triggers a reload, which finds the poll', async () => {
  await withBot({ overrides: { monitor: { pushDownMs: 1000 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    site.dropPush(true);
    await delay(200);
    const id = site.activate({ title: 'Connection is down', options: PLANETS });
    const started = await h.waitForEvent('recovery.start', undefined, 10000);
    assert.match(String(started['reason']), /live connection has been down/);
    await h.waitForEvent('poll.answered', undefined, 10000);
    assert.equal(site.responsesFor(id).length, 1);
    site.faults.pushDown = false;
  });
});

test('a push connection that drops and comes back is followed by a reload, which finds a missed poll', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    await delay(300);
    // Activate while the connection is being dropped: no open page hears about it.
    site.dropPush(false);
    const id = site.activate({ title: 'Missed while reconnecting', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 10000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('if the poll site is unreachable at start, the bot keeps retrying and connects when it comes up', async () => {
  // Reserve a port, then free it, so the bot starts against a closed port.
  const probe = await new MockSite().start();
  const port = Number(new URL(probe.origin).port);
  const url = probe.participantUrl();
  await probe.close();

  const site = new MockSite();
  const starting = (async () => {
    await delay(1500);
    await site.start(port);
  })();
  const h = await startBot(site, url);
  try {
    await starting;
    assert.ok(h.events('recovery.retry').length >= 1, 'it retried while the site was down');
    const id = site.activate({ title: 'Finally up', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  } finally {
    await h.stop().catch(() => undefined);
    await site.close();
    cleanup(h.dir);
  }
});

test('a page alert is dismissed and does not stall the bot', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    void page.evaluate(() => window.alert('Something happened')).catch(() => undefined);
    const dialog = await h.waitForEvent('page.dialog');
    assert.equal(dialog['type'], 'alert');
    const id = site.activate({ title: 'After the alert', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a dropped push connection is noticed from the channel state even though the "connected" mark stays', async () => {
  await withBot({ overrides: { monitor: { pushDownMs: 1000 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    site.dropPush(true);
    const page = h.bot.browser.page;
    assert.ok(page);
    await h.until(() => h.events('recovery.start').length >= 1, 'the bot to notice', 10000);
    const reason = String(h.events('recovery.start')[0]?.['reason']);
    assert.match(reason, /live connection has been down/);
    site.faults.pushDown = false;
  });
});

test('a network drop right after a poll appears does not use up the attempts; the poll is answered when it returns', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 600, max: 600 } } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    const id = site.activate({ title: 'Just before the outage', options: PLANETS });
    await h.waitForEvent('poll.detected');
    await page.context().setOffline(true);
    await delay(3500);
    await page.context().setOffline(false);
    await h.waitForEvent('poll.answered', undefined, 20000);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(h.events('poll.failed').length, 0);
  });
});
