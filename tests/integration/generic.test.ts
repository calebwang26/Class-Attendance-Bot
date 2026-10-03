import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

const generic = { url: (site: { genericUrl(): string }) => site.genericUrl() };

test('plain page: a radio-button poll with a separate Submit button is answered once', async () => {
  await withBot({ ...generic }, async (h, site) => {
    const id = site.activate({ title: 'Closest planet?', options: PLANETS });
    const detected = await h.waitForEvent('poll.detected');
    assert.equal(detected['kind'], 'multiple_choice');
    assert.equal(detected['question'], 'Closest planet?');
    assert.deepEqual(detected['options'], PLANETS);
    const answered = await h.waitForEvent('poll.answered');
    assert.match(String(answered['evidence']), /response was recorded/);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.value, 'Mercury');
    assert.equal(site.responsesFor(id)[0]?.source, 'generic');
    await delay(1200);
    assert.equal(site.attempts.length, 1);
  });
});

test('plain page: a text box poll gets the fixed text', async () => {
  await withBot({ ...generic }, async (h, site) => {
    const id = site.activate({ title: 'Say something' });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id)[0]?.value, 'value');
    await delay(1200);
    assert.equal(site.attempts.length, 1);
  });
});

test('plain page that says nothing after a submission: the emptied text box counts, and it is not sent twice', async () => {
  await withBot(
    {
      ...generic,
      before: (site) => {
        site.flags.genericSilent = true;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Say something', maxVotes: null });
      const answered = await h.waitForEvent('poll.answered', undefined, 12000);
      assert.match(String(answered['evidence']), /text box was emptied/);
      await delay(2500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
      // The form still looks open, and the page cannot show the earlier response: leave it alone.
      assert.ok(h.events('poll.duplicate_skipped').length <= 1);
      assert.equal(h.events('poll.responding').length, 1);
    },
  );
});

test('plain page: a failed submission is retried and recorded once', async () => {
  await withBot(
    {
      ...generic,
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
        site.faults.failSubmits = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Closest planet?', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 15000);
      assert.deepEqual(
        site.attempts.map((a) => a.outcome),
        ['failed', 'accepted'],
      );
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('plain page: a closed poll is not operated', async () => {
  await withBot({ ...generic }, async (h, site) => {
    site.activate({ title: 'Closed', options: PLANETS, state: 'closed' });
    await h.waitForEvent('poll.closed');
    await delay(800);
    assert.equal(site.attempts.length, 0);
  });
});

test('plain page: a second poll with the same wording replacing an answered one is answered too', async () => {
  await withBot({ ...generic }, async (h, site) => {
    const a = site.activate({ title: 'Same words', options: ['Yes', 'No'] });
    await h.waitForEvent('poll.answered');
    const b = site.activate({ title: 'Same words', options: ['Yes', 'No'] });
    await h.until(() => h.events('poll.answered').length === 2, 'the second poll to be answered', 10000);
    assert.equal(site.responsesFor(a).length, 1);
    assert.equal(site.responsesFor(b).length, 1);
    assert.equal(h.events('poll.responding')[1]?.['reason'], 'reopened');
  });
});

test('plain page: page buttons that are not part of a poll are never clicked', async () => {
  await withBot({ ...generic }, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    await page.evaluate(() => {
      (window as unknown as { clicks: string[] }).clicks = [];
      document.addEventListener('click', (e) => (window as unknown as { clicks: string[] }).clicks.push((e.target as HTMLElement).id || (e.target as HTMLElement).tagName), true);
    });
    const id = site.activate({ title: 'Closest planet?', options: PLANETS });
    await h.waitForEvent('poll.answered');
    const clicks = await page.evaluate(() => (window as unknown as { clicks: string[] }).clicks);
    assert.ok(!clicks.includes('help') && !clicks.includes('about'), `clicked: ${clicks.join(', ')}`);
    assert.equal(site.responsesFor(id).length, 1);
  });
});
