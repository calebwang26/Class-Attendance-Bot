import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LectureHours } from '../../src/schedule/lectureHours.ts';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

// Lecture times: one poll link can serve several sections' lectures, so the bot
// answers only during the person's own (8:00–9:30 here, with a 5-minute margin).

const LECTURE: LectureHours = { slots: [{ days: null, start: 8 * 60, end: 9 * 60 + 30 }] };

/** A clock the test can set. Only the lecture-time rule reads it. */
function settableClock(hour: number, minute: number): { clock: () => Date; set: (hour: number, minute: number) => void } {
  let now = new Date(2026, 9, 5, hour, minute);
  return {
    clock: () => now,
    set: (h, m) => {
      now = new Date(2026, 9, 5, h, m);
    },
  };
}

test('outside lecture time a poll is watched but not answered, and the user is told once', async () => {
  const time = settableClock(10, 49);
  await withBot({ lectureHours: LECTURE, clock: time.clock }, async (h, site) => {
    site.activate({ title: 'Another section', options: PLANETS });
    const skipped = await h.waitForEvent('poll.outside_lecture');
    assert.equal(skipped['firstSeenInLecture'], false);
    assert.match(String(skipped['message']), /it appeared outside your lecture times/);
    assert.ok(h.notifications.some((n) => /not lecture time/.test(n.title)));
    await delay(1500);
    assert.equal(site.attempts.length, 0);
    assert.equal(h.events('poll.outside_lecture').length, 1, 'reported once');
    const summary = await h.stop();
    assert.equal(summary.outsideLecture, 1);
    assert.equal(summary.answered, 0);
  });
});

test('during lecture time, including the 5-minute margin before it, polls are answered', async () => {
  const time = settableClock(7, 56);
  await withBot({ lectureHours: LECTURE, clock: time.clock }, async (h, site) => {
    const id = site.activate({ title: 'Early start', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(h.events('poll.outside_lecture').length, 0);
  });
});

test('a poll left showing from before lecture time is not answered when lecture time begins; a new one is', async () => {
  const time = settableClock(7, 30);
  await withBot({ lectureHours: LECTURE, clock: time.clock }, async (h, site) => {
    const stale = site.activate({ title: 'Left up from yesterday', options: PLANETS });
    await h.waitForEvent('poll.outside_lecture');
    time.set(8, 5);
    await h.waitForEvent('lecture.started');
    await delay(1500);
    assert.equal(site.responsesFor(stale).length, 0, 'the stale poll is still left alone');

    site.deactivate();
    await delay(900);
    const fresh = site.activate({ title: 'In my lecture', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(fresh).length, 1);
    assert.equal(site.attempts.length, 1);
  });
});

test('when lecture time ends during retries, no further attempt is made', async () => {
  const time = settableClock(9, 20);
  await withBot(
    {
      lectureHours: LECTURE,
      clock: time.clock,
      overrides: { response: { confirmTimeoutMs: 1500, retryDelayMs: 600, maxAttempts: 5 } },
      before: (site) => {
        site.faults.failSubmits = 10;
      },
    },
    async (h, site) => {
      site.activate({ title: 'Near the end', options: PLANETS });
      await h.until(() => site.attempts.length >= 1, 'the first attempt', 15000);
      time.set(9, 40);
      const skipped = await h.waitForEvent('poll.outside_lecture', undefined, 15000);
      assert.equal(skipped['firstSeenInLecture'], true);
      assert.match(String(skipped['message']), /lecture time ended before it could be answered/);
      const attempts = site.attempts.length;
      await delay(2500);
      assert.equal(site.attempts.length, attempts, 'nothing more was sent');
    },
  );
});

test('the start and end of lecture time are announced', async () => {
  const time = settableClock(7, 0);
  await withBot({ lectureHours: LECTURE, clock: time.clock }, async (h) => {
    const before = await h.waitForEvent('lecture.ended');
    assert.match(String(before['message']), /It is not lecture time: watching only, no answers\. Answering starts today 7:55am\./);
    time.set(8, 0);
    const started = await h.waitForEvent('lecture.started');
    assert.match(String(started['message']), /Lecture time has started/);
    time.set(9, 40);
    const ended = await h.waitForEvent('lecture.ended', (e) => /is over/.test(String(e['message'])));
    assert.match(String(ended['message']), /Lecture time is over: watching only, no answers\. Answering starts tomorrow 7:55am\./);
  });
});

test('without lecture times every poll is answered (as before)', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Any time', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(h.events('lecture.started').length + h.events('lecture.ended').length, 0);
  });
});
