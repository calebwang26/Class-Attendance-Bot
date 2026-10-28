import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

test('when signed out, the bot asks the user to sign in and answers nothing', async () => {
  await withBot(
    {
      before: (site) => {
        site.flags.signedIn = false;
      },
    },
    async (h, site) => {
      const attention = await h.waitForEvent('attention');
      assert.equal(attention['reason'], 'signed_out');
      assert.ok(h.notifications.some((n) => /sign in/i.test(n.title)));
      site.activate({ title: 'Pick', options: PLANETS });
      await delay(1500);
      assert.equal(site.attempts.length, 0);
      assert.equal(h.events('poll.responding').length, 0);

      // The user signs in: the page reloads signed in, and the bot carries on by itself.
      site.setFlag('signedIn', true);
      await h.waitForEvent('attention.cleared');
      await h.waitForEvent('poll.answered');
      assert.equal(site.ledger.length, 1);
    },
  );
});

test('with sign-in not required, a signed-out page is answered', async () => {
  await withBot(
    {
      overrides: { requireSignIn: false },
      before: (site) => {
        site.flags.signedIn = false;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered');
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('a sign-in page pauses the bot; nothing is typed into it', async () => {
  await withBot({ url: (site) => `${site.origin}/login` }, async (h) => {
    const attention = await h.waitForEvent('attention');
    assert.equal(attention['reason'], 'sign_in');
    await delay(1500);
    const page = h.bot.browser.page;
    assert.ok(page);
    assert.equal(await page.locator('input[name="email"]').inputValue(), '');
    assert.equal(await page.locator('input[name="password"]').inputValue(), '');
    assert.equal(new URL(page.url()).pathname, '/login', 'the bot did not navigate away from the sign-in page');
  });
});

test('a modal dialog over the page pauses the bot and tells the user', async () => {
  await withBot(
    {
      before: (site) => {
        site.flags.screenNameDialog = true;
      },
    },
    async (h, site) => {
      const attention = await h.waitForEvent('attention');
      assert.equal(attention['reason'], 'dialog');
      assert.match(String(attention['message']), /Screen name configuration/);
      const recorded = await h.waitForEvent('dialog.recorded');
      assert.equal(recorded['title'], 'Screen name configuration');
      assert.deepEqual(recorded['buttons'], ['Continue']);
      assert.match(String(recorded['text']), /What should we call you\?/);
      assert.match(String(recorded['html']), /name="screen_name"/);
      assert.ok(fs.existsSync(String(recorded['screenshot'])), 'a screenshot of the dialog was saved');
      site.activate({ title: 'Pick', options: PLANETS });
      await delay(1200);
      assert.equal(site.attempts.length, 0);
      const page = h.bot.browser.page;
      assert.ok(page);
      assert.equal(await page.locator('input[name="screen_name"]').inputValue(), '', 'nothing typed into the dialog');

      site.setFlag('screenNameDialog', false);
      await h.waitForEvent('poll.answered');
      assert.equal(site.ledger.length, 1);
    },
  );
});

test('when something covers the option, the bot answers with the keyboard instead of the mouse', async () => {
  await withBot(
    {
      before: (site) => {
        site.flags.overlay = true;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Pick', options: PLANETS });
      await h.waitForEvent('poll.answered', undefined, 15000);
      assert.equal(site.responsesFor(id).length, 1);
      assert.equal(site.attempts.length, 1);
      const activated = h.events('submit.activated')[0];
      assert.equal(activated?.['method'], 'keyboard');
    },
  );
});

test('a covered free-text poll is still answered', async () => {
  await withBot(
    {
      before: (site) => {
        site.flags.overlay = true;
      },
    },
    async (h, site) => {
      const id = site.activate({ title: 'Words' });
      await h.waitForEvent('poll.answered', undefined, 15000);
      assert.equal(site.responsesFor(id)[0]?.value, 'value');
      assert.equal(site.attempts.length, 1);
    },
  );
});

test('the cookie notice is left alone and mentioned once', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('hint.cookie_banner');
    site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    const page = h.bot.browser.page;
    assert.ok(page);
    assert.equal(await page.locator('#cookie-consent-banner').count(), 1, 'the bot did not click the cookie notice');
    assert.equal(h.events('hint.cookie_banner').length, 1);
  });
});

test('the live/pinned tab buttons are never mistaken for a poll', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    await delay(1500);
    assert.equal(h.events('poll.detected').length, 0);
    assert.equal(site.attempts.length, 0);
    const page = h.bot.browser.page;
    assert.ok(page);
    assert.equal(await page.locator('[data-tab="current"]').getAttribute('aria-selected'), 'true');
  });
});

test('if the pinned tab gets selected, the bot goes back to the live activity', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const page = h.bot.browser.page;
    assert.ok(page);
    await page.locator('[data-tab="pinned"]').click({ force: true });
    const id = site.activate({ title: 'Live again', options: PLANETS });
    await h.waitForEvent('poll.answered', undefined, 15000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

for (const [type, name] of [
  ['ranking_poll', 'rank order'],
  ['survey', 'survey'],
  ['clickable_image', 'clickable image'],
  ['discourse', 'q and a'],
] as const) {
  test(`an unsupported activity (${name}) is reported to the user and nothing is clicked or typed`, async () => {
    await withBot({}, async (h, site) => {
      site.activate({ title: `An activity of type ${type}`, options: type === 'ranking_poll' ? PLANETS : undefined, type });
      const event = await h.waitForEvent('poll.unsupported');
      assert.match(String(event['message']), new RegExp(name));
      assert.ok(h.notifications.some((n) => /answer this one yourself/i.test(n.title)));
      await delay(1200);
      assert.equal(site.attempts.length, 0);
      assert.equal(h.events('poll.responding').length, 0);
      const page = h.bot.browser.page;
      assert.ok(page);
      const typed = await page.evaluate(() => Array.from(document.querySelectorAll('textarea')).map((t) => t.value).join(''));
      assert.equal(typed, '', 'nothing typed');
      const summary = await h.stop();
      assert.equal(summary.unsupported, 1);
      assert.equal(h.events('poll.unsupported').length, 1);
    });
  });
}

test('a competition between questions shows nothing to answer; its multiple-choice question is answered', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Trivia night', type: 'competition', displayState: 'welcome' });
    await delay(1200);
    assert.equal(h.events('poll.detected').length, 0);
    assert.equal(h.events('page.unknown').length, 0);
    const id = site.activate({ title: 'Question 1', type: 'competition', displayState: 'instructions', options: PLANETS });
    // The mock scores only standard polls, so check what the bot did on the page.
    await h.waitForEvent('poll.detected');
    await h.until(() => site.attempts.length === 1, 'one click on an option', 8000);
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a locked poll is not clicked; it is answered once the presenter unlocks it', async () => {
  await withBot({}, async (h, site) => {
    const id = site.activate({ title: 'Locked at first', options: PLANETS, state: 'closed' });
    const closed = await h.waitForEvent('poll.closed');
    assert.match(String(closed['evidence']), /locked/);
    await delay(800);
    assert.equal(site.attempts.length, 0);
    site.unlock();
    await h.waitForEvent('poll.answered');
    assert.equal(site.responsesFor(id).length, 1);
  });
});

test('a poll locked during the response delay is not clicked, and nothing loops', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 1000, max: 1000 } } } }, async (h, site) => {
    site.activate({ title: 'Locks quickly', options: PLANETS });
    await h.waitForEvent('poll.detected');
    site.lock();
    await delay(2000);
    assert.equal(site.attempts.length, 0);
    assert.equal(h.events('poll.responding').length, 0);
    assert.equal(h.events('poll.closed').length, 1);
  });
});

test('a page the bot does not recognise is reloaded once, then reported with what it saw; nothing is clicked', async () => {
  await withBot(
    {
      before: (site) => {
        site.flags.unknownWidget = true;
      },
    },
    async (h, site) => {
      const loads = site.pageLoads;
      const unknown = await h.waitForEvent('page.unknown', undefined, 8000);
      assert.match(String(unknown['reason']), /does not recognise/);
      assert.match(String(unknown['pageText']), /Spin the wheel/);
      assert.ok(h.notifications.some((n) => /unrecognised/.test(n.title)));
      assert.ok(site.pageLoads > loads, 'it tried loading the page afresh first');
      await delay(1500);
      assert.equal(h.events('page.unknown').length, 1, 'reported once');
      assert.equal(site.attempts.length, 0);
      const page = h.bot.browser.page;
      assert.ok(page);
      assert.equal(await page.locator('#spin').count(), 1);

      // Once the page shows a normal poll again, the bot carries on.
      site.flags.unknownWidget = false;
      const id = site.activate({ title: 'Back to normal', options: PLANETS });
      await h.waitForEvent('poll.answered');
      assert.equal(site.responsesFor(id).length, 1);
    },
  );
});

test('with shareLocation on, only Poll Everywhere sites are allowed to read the location', async () => {
  const permissionOn = async (page: import('playwright').Page, url: string): Promise<string> => {
    const probe = await page.context().newPage();
    try {
      await probe.route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>probe</title>' }));
      await probe.goto(url);
      return await probe.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state);
    } finally {
      await probe.close();
    }
  };
  for (const shareLocation of [true, false]) {
    await withBot({ overrides: { browser: { shareLocation } } }, async (h) => {
      await h.waitForEvent('watching');
      const page = h.bot.browser.page;
      assert.ok(page);
      const expected = shareLocation ? 'granted' : 'prompt';
      assert.equal(await permissionOn(page, 'https://pollev.com/someone'), expected);
      assert.equal(await permissionOn(page, 'https://pe.app/someone'), expected);
      assert.equal(await permissionOn(page, 'https://example.com/'), 'prompt', 'other sites are never given the location');
    });
  }
});

test('extensions installed in the profile are left on unless browser.extensions is turned off', async () => {
  for (const extensions of [true, false]) {
    await withBot({ overrides: { browser: { extensions } } }, async (h) => {
      await h.waitForEvent('watching');
      // The browser's own process: the one started with this test's profile.
      const browserLine = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' })
        .split('\n')
        .find((line) => line.includes(`--user-data-dir=${h.config.browser.profileDir}`) && !line.includes('--type='));
      assert.ok(browserLine, 'the browser process was found');
      assert.equal(/--disable-extensions(\s|$)/.test(browserLine), !extensions, browserLine);
    });
  }
});
