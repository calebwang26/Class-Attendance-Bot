import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

test('a poll activated on the waiting screen is detected within one second', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'skip' } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const activatedAt = Date.now();
    site.activate({ title: 'Closest planet?', options: PLANETS });
    const detected = await h.waitForEvent('poll.detected');
    assert.ok(Date.parse(detected.ts) - activatedAt < 1000, `took ${Date.parse(detected.ts) - activatedAt} ms`);
    assert.equal(detected['kind'], 'multiple_choice');
    assert.equal(detected['question'], 'Closest planet?');
    assert.deepEqual(detected['options'], PLANETS);
    assert.equal(h.events('poll.detected').length, 1);
  });
});

test('a free-text poll is detected and classified as free text', async () => {
  await withBot({ overrides: { response: { freeText: 'skip' } } }, async (h, site) => {
    site.activate({ title: 'One word for today?' });
    const detected = await h.waitForEvent('poll.detected');
    assert.equal(detected['kind'], 'free_text');
    assert.deepEqual(detected['options'], []);
  });
});

test('a poll that is already active when the page loads is detected and answered', async () => {
  let id = '';
  await withBot(
    {
      before: (site) => {
        id = site.activate({ title: 'Already here', options: PLANETS });
      },
    },
    async (h, site) => {
      await h.waitForEvent('poll.answered');
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(h.events('poll.detected').length, 1);
    },
  );
});

test('a new poll that directly replaces an answered one is detected (no waiting screen in between)', async () => {
  await withBot({}, async (h, site) => {
    const first = site.activate({ title: 'First', options: PLANETS });
    await h.waitForEvent('poll.answered', (e) => e['response'] === 'Mercury');
    const second = site.activate({ title: 'Second', options: ['Red', 'Green', 'Blue'] });
    await h.waitForEvent('poll.answered', (e) => e['response'] === 'Red');
    const third = site.activate({ title: 'Third, in words' });
    await h.waitForEvent('poll.answered', (e) => e['response'] === 'value');
    assert.deepEqual(
      h.events('poll.detected').map((e) => e['question']),
      ['First', 'Second', 'Third, in words'],
    );
    for (const id of [first, second, third]) assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.ledger.length, 3);
  });
});

test('a new poll drawn into the same page element (text changed in place) is detected', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.reuseMount = true;
      },
    },
    async (h, site) => {
      site.activate({ title: 'First', options: PLANETS });
      await h.waitForEvent('poll.answered', (e) => e['response'] === 'Mercury');
      const second = site.activate({ title: 'Second', options: ['Red', 'Green', 'Blue'] });
      await h.waitForEvent('poll.answered', (e) => e['response'] === 'Red');
      assert.equal(site.responsesFor(second).length, 1);
      assert.equal(site.ledger.length, 2);
    },
  );
});

test('a slowly drawn poll is reported once, complete, and only then answered', async () => {
  await withBot(
    {
      before: (site) => {
        site.faults.mountDelayMs = 300;
        site.faults.skeletonMs = 500;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Slow one', options: PLANETS });
      await h.waitForEvent('poll.answered');
      const detected = h.events('poll.detected');
      assert.equal(detected.length, 1);
      assert.deepEqual(detected[0]?.['options'], PLANETS);
      assert.equal(detected[0]?.['question'], 'Slow one');
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('detection works on change events alone (periodic reading effectively off)', async () => {
  await withBot({ overrides: { monitor: { fallbackPollMs: 600000 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    await delay(300);
    const id = site.activate({ title: 'Event driven', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 5000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('detection works on periodic reading alone (change events off)', async () => {
  await withBot({ overrides: { monitor: { eventDriven: false, fallbackPollMs: 250 } } }, async (h, site) => {
    await h.waitForEvent('watching');
    const id = site.activate({ title: 'Polling only', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 8000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('options edited in place before the poll opens are read fresh when it is answered', async () => {
  await withBot({ overrides: { response: { multipleChoice: 'last' } } }, async (h, site) => {
    const id = site.activate({ title: 'Editable', options: ['A', 'B'], state: 'closed' });
    await h.waitForEvent('poll.closed');
    site.edit({ options: ['A', 'B', 'C', 'D'] });
    await delay(200);
    site.unlock();
    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'D');
    assert.equal(site.responsesFor(id)[0]?.value, 'D');
    assert.equal(site.ledger.length, 1);
  });
});

test('going back to the waiting screen and on to a new poll works', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Before the break', options: PLANETS });
    await h.waitForEvent('poll.answered');
    site.deactivate();
    await h.until(() => h.events('watching').length >= 1 && h.lines.some((l) => l.includes('no poll is showing')), 'waiting screen');
    await delay(300);
    const id = site.activate({ title: 'After the break', options: PLANETS });
    await h.waitForEvent('poll.answered', (e) => e['fingerprint'] !== h.events('poll.answered')[0]?.['fingerprint']);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.ledger.length, 2);
  });
});
