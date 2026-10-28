import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LectureHours } from '../../src/schedule/lectureHours.ts';
import { delay, PLANETS, withBot, type Harness } from '../helpers/harness.ts';
import type { MockSite } from '../../mock-site/server.ts';

// Poll Everywhere's location check-in: during lecture time the bot clicks "Check in",
// and the page sends the location the browser gives it. Here the test plays the part
// of the operating system and gives the browser a location for the mock site.

const LECTURE: LectureHours = { slots: [{ days: null, start: 8 * 60, end: 9 * 60 + 30 }] };
const CLASSROOM = { latitude: 37.8719, longitude: -122.2585 };
const HOME = { latitude: 37.7749, longitude: -122.4194 };

const clockAt = (hour: number, minute: number): (() => Date) => () => new Date(2026, 9, 28, hour, minute);

/** Lets the mock site read `where` as the browser's location. */
async function giveLocation(h: Harness, site: MockSite, where: { latitude: number; longitude: number }): Promise<void> {
  const page = h.bot.browser.page;
  assert.ok(page);
  await page.context().grantPermissions(['geolocation'], { origin: site.origin });
  await page.context().setGeolocation({ ...where, accuracy: 30 });
}

/** Starts a check-in and waits for the bot to read it as `expect` (state, or state:detail). */
async function startCheckIn(h: Harness, site: MockSite, expect = 'check_in'): Promise<void> {
  site.checkInPlace = { ...CLASSROOM, radiusM: 200 };
  site.setFlag('checkIn', true);
  await h.waitForEvent('page.state', (e) => [e['state'], `${String(e['state'])}:${String(e['detail'])}`].includes(expect));
}

test('during lecture time the bot clicks "Check in" and the page sends the location it was given', async () => {
  await withBot({ lectureHours: LECTURE, clock: clockAt(8, 30) }, async (h, site) => {
    await h.waitForEvent('watching');
    await giveLocation(h, site, CLASSROOM);
    await startCheckIn(h, site);
    const done = await h.waitForEvent('checkin.done', undefined, 15000);
    assert.match(String(done['message']), /Checked in/);
    assert.equal(site.checkIns.length, 1);
    const [entry] = site.checkIns;
    assert.equal(entry?.accepted, true);
    assert.equal(entry?.latitude, CLASSROOM.latitude);
    assert.equal(entry?.longitude, CLASSROOM.longitude);
    assert.equal(h.events('checkin.clicked').length, 1);
    assert.ok(h.notifications.some((n) => /checked you in/.test(n.title)));

    // Polls are answered as usual afterwards.
    const id = site.activate({ title: 'After the check-in', options: PLANETS });
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a check-in Poll Everywhere turns down is reported, and not clicked again straight away', async () => {
  await withBot({ lectureHours: LECTURE, clock: clockAt(8, 30) }, async (h, site) => {
    await h.waitForEvent('watching');
    await giveLocation(h, site, HOME);
    await startCheckIn(h, site);
    const failed = await h.waitForEvent('checkin.failed', undefined, 15000);
    assert.match(String(failed['message']), /could not check you in/);
    assert.ok(h.notifications.some((n) => /check-in failed/.test(n.title)));
    assert.equal(site.checkIns.length, 1);
    assert.equal(site.checkIns[0]?.accepted, false);
    assert.equal(site.checkIns[0]?.latitude, HOME.latitude, 'the real (given) location was sent, nothing else');

    // The panel is still asking. The bot leaves it to the person rather than clicking again.
    const attention = await h.waitForEvent('attention', (e) => String(e['key']).startsWith('check_in:'));
    assert.match(String(attention['message']), /not clicking "Check in" again|less than two minutes ago/);
    await delay(1500);
    assert.equal(site.checkIns.length, 1);
    assert.equal(h.events('checkin.clicked').length, 1);
  });
});

test('outside lecture time, in a dry run, or without location sharing, "Check in" is not clicked', async () => {
  const cases: { name: string; options: Parameters<typeof withBot>[0]; why: RegExp }[] = [
    { name: 'outside lecture time', options: { lectureHours: LECTURE, clock: clockAt(11, 0) }, why: /not your lecture time/ },
    { name: 'dry run', options: { overrides: { dryRun: true } }, why: /dry run/ },
    { name: 'location not shared', options: { overrides: { browser: { shareLocation: false } } }, why: /not sharing your location/ },
    { name: 'check-in turned off', options: { overrides: { checkIn: false } }, why: /turned off/ },
    {
      name: 'signed out',
      options: {
        before: (site) => {
          site.flags.signedIn = false;
        },
      },
      why: /Check in by hand/,
    },
  ];
  for (const c of cases) {
    await withBot(c.options, async (h, site) => {
      if (c.name !== 'signed out') await h.waitForEvent('watching');
      else await h.waitForEvent('page.state');
      await giveLocation(h, site, CLASSROOM);
      await startCheckIn(h, site, c.name === 'signed out' ? 'needs_user:dialog' : 'check_in');
      if (c.name === 'signed out') {
        // Not credited while signed out: the bot asks the person to sign in and leaves the panel alone.
        await h.waitForEvent('attention', (e) => e['reason'] === 'signed_out' || e['reason'] === 'dialog');
      } else {
        const attention = await h.waitForEvent('attention', (e) => String(e['key']).startsWith('check_in:'));
        assert.match(String(attention['message']), c.why, c.name);
        assert.ok(h.notifications.some((n) => /location check-in/.test(n.title)), c.name);
      }
      await delay(1000);
      assert.equal(site.checkIns.length, 0, c.name);
      assert.equal(h.events('checkin.clicked').length, 0, c.name);
      const page = h.bot.browser.page;
      assert.ok(page);
      assert.equal(await page.locator('[data-controller="participate--check-in"]').count(), 1, `${c.name}: the panel is left as it was`);
    });
  }
});

test('the page reading finds the one "Check in" button, never "Continue without check-in"', async () => {
  await withBot({ overrides: { dryRun: true } }, async (h, site) => {
    await h.waitForEvent('watching');
    site.setFlag('checkIn', true);
    await h.waitForEvent('page.state', (e) => e['state'] === 'check_in');
    const read = await h.bot.browser.snapshot();
    assert.ok(read.ok);
    assert.equal(read.snapshot.checkIn.showing, true);
    assert.equal(read.snapshot.checkIn.failed, false);
    const ref = read.snapshot.checkIn.buttonRef;
    assert.ok(ref);
    const handle = await h.bot.browser.resolve(ref);
    assert.ok(handle);
    assert.equal(await handle.evaluate((el) => (el as HTMLElement).innerText.trim()), 'Check in');

    // Two buttons that both say "Check in": not certain which is meant, so neither.
    const page = h.bot.browser.page;
    assert.ok(page);
    await page.evaluate(() => {
      const panel = document.querySelector('[data-participate--check-in-target="request"]');
      const copy = document.querySelector('[data-check-in="go"]')?.cloneNode(true);
      if (panel && copy) panel.appendChild(copy);
    });
    const again = await h.bot.browser.snapshot();
    assert.ok(again.ok);
    assert.equal(again.snapshot.checkIn.showing, true);
    assert.equal(again.snapshot.checkIn.buttonRef, null);
  });
});
