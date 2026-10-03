import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { buildConfig } from '../../src/config/config.ts';
import { AnsweredStore } from '../../src/dedupe/store.ts';
import { Logger } from '../../src/logger/logger.ts';
import { Orchestrator } from '../../src/orchestrator/orchestrator.ts';
import { botParticipant, cleanup, delay, FAST, makeScratchDir, PLANETS, withBot } from '../helpers/harness.ts';

// Scenarios from a second review of the retry and server-check logic.

test('a server check that falls during an outage does not leave the bot idle once the network is back', async () => {
  await withBot(
    {
      overrides: { monitor: { recovery: { initialMs: 1000, maxMs: 5000 } } },
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
      await delay(6000);
      await page.context().setOffline(false);
      const back = Date.now();
      await h.waitForEvent('poll.answered', undefined, 20000);
      const answeredAt = Date.parse(h.events('poll.answered')[0]?.ts ?? '');
      assert.ok(answeredAt - back < 10000, `answered ${answeredAt - back} ms after the network returned`);
      assert.equal(site.responsesFor(id).length, 1, 'no second vote');
    },
  );
});

test('no reload cuts off a vote the server is still processing (periodic reload due)', async () => {
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1500 }, monitor: { resyncMs: 1000 } },
      before: (site) => {
        site.faults.submitDelayMs = 4000;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.waitForEvent('poll.answered', undefined, 20000);
      await delay(2000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('no reload cuts off a vote the server is still processing (live connection drops meanwhile)', async () => {
  await withBot(
    {
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.submitDelayMs = 4000;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.until(() => h.events('submit.activated').length >= 1, 'the click');
      site.dropPush(false);
      await h.waitForEvent('poll.answered', undefined, 20000);
      await delay(2000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('plain page: the check reload never cuts off a vote the server is still processing', async () => {
  await withBot(
    {
      url: (s) => s.genericUrl(),
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.submitDelayMs = 4000;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.waitForEvent('poll.answered', undefined, 25000);
      await delay(2000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('an explicit server error is retried after the normal pause, without a server check', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered');
      const [first, second] = site.attempts;
      assert.ok(first && second);
      const gap = Date.parse(second.at) - Date.parse(first.at);
      assert.ok(gap < 2500, `second attempt ${gap} ms after the first`);
      assert.equal(h.events('poll.server_check').length, 0);
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('an explicit server error on a page that never reloads earlier votes is still retried and answered', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.noRestore = true;
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered');
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.duplicate_skipped').length, 0);
    },
  );
});

test('a lost reply, then the poll leaves and comes back: still checked with the server, no second vote', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.dropReplies = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick any', options: PLANETS, maxVotes: null });
      await h.until(() => site.attempts.length >= 1, 'the first submission');
      await h.waitForEvent('poll.attempt_failed', undefined, 10000);
      site.deactivate();
      await delay(1200);
      site.reactivate(id);
      await h.waitForEvent('poll.answered', undefined, 20000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('a re-vote on a page that briefly shows the waiting screen after loading is checked once, not in a loop', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.waitingFlashMs = 300;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Vote again', options: PLANETS });
      await h.waitForEvent('poll.answered');
      site.clearResponses();
      await h.until(() => h.events('poll.answered').length === 2, 'the re-vote', 20000);
      await delay(2000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.ledger.length, 2);
      assert.ok(h.events('poll.server_check').length <= 2, `${h.events('poll.server_check').length} checks`);
    },
  );
});

test('an in-page address change while earlier responses load does not let the bot click early', async () => {
  let id = '';
  await withBot(
    {
      overrides: { monitor: { settleMs: 100 } },
      before: (site) => {
        site.faults.resultsDelayMs = 1500;
        site.faults.pushStateMs = 150;
      },
    },
    async (h, site) => {
      await h.waitForEvent('watching');
      id = site.activate({ title: 'Pick', options: PLANETS, id: 'push-state-poll' });
      site.respondAs(botParticipant(site), id, { optionIndex: 1 });
      site.remount();
      await h.waitForEvent('poll.already_answered', undefined, 10000);
      await delay(1000);
      assert.equal(site.attempts.length, 0);
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test("after giving up, a response the user sends by hand on a plain page is not claimed as the bot's", async () => {
  await withBot(
    {
      url: (s) => s.genericUrl(),
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.failSubmits = 50;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Say something' });
      await h.waitForEvent('poll.failed', undefined, 40000);
      site.faults.failSubmits = 0;
      const page = h.bot.browser.page;
      assert.ok(page);
      await page.locator('textarea').fill('my own words');
      await page.locator('button[type="submit"]').click({ force: true });
      await h.waitForEvent('poll.already_answered', undefined, 10000);
      assert.equal(site.responsesFor(id)[0]?.value, 'my own words');
      assert.equal(h.events('poll.answered').length, 0);
      const summary = await h.stop();
      assert.equal(summary.answered, 0);
      assert.equal(summary.alreadyAnswered, 1);
    },
  );
});

test('a second chance that succeeds turns "could not answer" into "answered" and says so', async () => {
  await withBot(
    {
      overrides: { monitor: { resyncMs: 1500 } },
      before: (site) => {
        site.faults.failSubmits = 3;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.failed', undefined, 20000);
      await h.waitForEvent('poll.second_chance', undefined, 20000);
      await h.waitForEvent('poll.answered', undefined, 20000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.ok(h.notifications.some((n) => /answered after all/.test(n.title)));
      const summary = await h.stop();
      assert.equal(summary.answered, 1);
      assert.equal(summary.failed, 0);
    },
  );
});

test('stopping while the browser is still starting leaves no browser running', async () => {
  const dir = makeScratchDir();
  try {
    const config = buildConfig(FAST, {
      browser: { profileDir: path.join(dir, 'profile') },
      dedupe: { file: path.join(dir, 'answered.json') },
      logging: { dir: path.join(dir, 'logs') },
    });
    const logger = new Logger({ dir: config.logging.dir, level: 'info', redactQuestionText: false, sessionId: 'stop-during-launch', print: () => undefined });
    const { store } = AnsweredStore.open(config.dedupe.file, { retainDays: 30 });
    const bot = new Orchestrator({ config, logger, store, profileDir: config.browser.profileDir, screenshotDir: path.join(dir, 'shots'), notify: () => undefined });
    const run = bot.run('http://127.0.0.1:9/never');
    setTimeout(() => bot.stop('stopped early'), 30);
    const summary = await run;
    assert.equal(summary.stopReason, 'stopped early');
    await delay(1500);
    let running = '';
    try {
      running = execFileSync('pgrep', ['-f', config.browser.profileDir], { encoding: 'utf8' }).trim();
    } catch {
      running = '';
    }
    assert.equal(running, '', `browser processes still using the profile: ${running}`);
  } finally {
    cleanup(dir);
  }
});
