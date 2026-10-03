import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

// "Poll Everywhere 2.0" (pe.app): a server-drawn page where each option is its
// own form, and a click sends the vote as an ordinary form request.

const pe2 = { url: (site: { pe2Url(): string }) => site.pe2Url() };

test('Poll Everywhere 2.0: a multiple-choice poll is answered once and confirmed by the server', async () => {
  await withBot({ ...pe2 }, async (h, site) => {
    const id = site.activate({ title: 'Favourite planet?', options: PLANETS });
    const detected = await h.waitForEvent('poll.detected');
    assert.equal(detected['kind'], 'multiple_choice');
    assert.equal(detected['question'], 'Favourite planet?');
    assert.deepEqual(detected['options'], PLANETS);

    const answered = await h.waitForEvent('poll.answered');
    assert.equal(answered['response'], 'Mercury');
    assert.match(String(answered['evidence']), /server accepted the response and "Mercury" is marked as your vote/);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.source, 'pe2');
    await delay(1500);
    assert.equal(site.attempts.length, 1);
    const summary = await h.stop();
    assert.equal(summary.answered, 1);
    assert.equal(summary.failed, 0);
  });
});

test('Poll Everywhere 2.0: a free-text poll gets "value" once, though the page does not show it afterwards', async () => {
  await withBot({ ...pe2 }, async (h, site) => {
    const id = site.activate({ title: 'Say something', maxVotes: null });
    const answered = await h.waitForEvent('poll.answered', undefined, 12000);
    assert.equal(answered['response'], 'value');
    assert.match(String(answered['evidence']), /^the server accepted the response$/);
    await delay(2500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(id)[0]?.value, 'value');
    assert.equal(site.attempts.length, 1);
    assert.equal(h.events('poll.responding').length, 1);
  });
});

test('Poll Everywhere 2.0: each new poll is answered in turn', async () => {
  await withBot({ ...pe2 }, async (h, site) => {
    const first = site.activate({ title: 'First', options: PLANETS });
    await h.waitForEvent('poll.answered');
    site.deactivate();
    await delay(800);
    const second = site.activate({ title: 'Second', options: ['Yes', 'No'] });
    await h.waitForEvent('poll.answered', (e) => e['response'] === 'Yes', 12000);
    assert.equal(site.responsesFor(first).length, 1);
    assert.equal(site.responsesFor(second).length, 1);
    assert.equal(site.attempts.length, 2);
  });
});

test('Poll Everywhere 2.0: a server error is retried, and the vote is recorded once', async () => {
  await withBot(
    {
      ...pe2,
      overrides: { response: { confirmTimeoutMs: 1500 } },
      before: (site) => {
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
    },
  );
});

test('Poll Everywhere 2.0: a lost reply is checked with the server, not sent again', async () => {
  await withBot(
    {
      ...pe2,
      before: (site) => {
        site.faults.dropReplies = 1;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 15000);
      await delay(1500);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
      assert.equal(h.events('poll.failed').length, 0);
    },
  );
});

test('Poll Everywhere 2.0: a vote already on the page is left alone', async () => {
  await withBot(
    {
      ...pe2,
      before: (site) => {
        // The bot's browser has no participant cookie yet, so vote for it once it loads the page.
        site.onRender = () => {
          site.onRender = null;
          const [participant] = [...site.participants];
          const active = site.active;
          if (participant && active) site.respondAs(participant, active.id, { optionIndex: 2 });
        };
        site.activate({ title: 'Pick', options: PLANETS });
      },
    },
    async (h, site) => {
      // The vote was recorded as the first page was drawn; the next drawing shows it.
      site.forceReload();
      const seen = await h.waitForEvent('poll.already_answered', undefined, 12000);
      assert.match(String(seen['evidence']), /"Earth" is marked as your vote/);
      await delay(1500);
      assert.equal(site.attempts.length, 0);
    },
  );
});

test('Poll Everywhere 2.0: when signed out, nothing is answered until the user signs in', async () => {
  await withBot(
    {
      ...pe2,
      before: (site) => {
        site.flags.signedIn = false;
      },
    },
    async (h, site) => {
      const attention = await h.waitForEvent('attention');
      assert.equal(attention['reason'], 'signed_out');
      site.activate({ title: 'Pick', options: PLANETS });
      await delay(1500);
      assert.equal(site.attempts.length, 0);

      site.setFlag('signedIn', true);
      await h.waitForEvent('attention.cleared');
      await h.waitForEvent('poll.answered');
      assert.equal(site.ledger.length, 1);
    },
  );
});

test('Poll Everywhere 2.0: a closed poll is not operated', async () => {
  await withBot({ ...pe2 }, async (h, site) => {
    site.activate({ title: 'Closed', options: PLANETS, state: 'closed' });
    await h.waitForEvent('poll.closed');
    await delay(1000);
    assert.equal(site.attempts.length, 0);
  });
});

test('Poll Everywhere 2.0: an activity type the bot does not answer is reported, not operated', async () => {
  await withBot({ ...pe2 }, async (h, site) => {
    site.activate({ title: 'Rank these', type: 'ranking_poll', options: PLANETS });
    const event = await h.waitForEvent('poll.unsupported');
    assert.equal(event['type'], 'ranking');
    await delay(1000);
    assert.equal(site.attempts.length, 0);
  });
});
