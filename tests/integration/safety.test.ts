import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, delay, PLANETS, startBot, startMockSite, withBot } from '../helpers/harness.ts';

test('a form on some other page is never operated; the bot returns to the poll link and answers there', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    const id = site.activate({ title: 'Pick', options: PLANETS });
    await h.waitForEvent('poll.answered');
    // The browser ends up on a different page of the same site that also has a radio-button form.
    const next = site.activate({ title: 'Different page, same site', options: PLANETS });
    await h.waitForEvent('poll.answered', (e) => e['fingerprint'] !== h.events('poll.answered')[0]?.['fingerprint']);
    site.redirect('/generic/room');
    await h.waitForEvent('recovery.start');
    await h.waitForEvent('recovery.ok');
    await delay(500);
    assert.equal(site.responsesFor(id).length, 1);
    assert.equal(site.responsesFor(next).length, 1);
    assert.ok(site.ledger.every((entry) => entry.source === 'pollev'), 'nothing was submitted through the other page');
    assert.equal(site.attempts.length, 2);
  });
});

test('a page that keeps leaving the poll link is reported to the user', async () => {
  await withBot({}, async (h, site) => {
    await h.waitForEvent('watching');
    for (let i = 0; i < 3; i += 1) {
      site.redirect('/elsewhere');
      await h.until(() => h.events('recovery.ok').length === i + 1, `return ${i + 1}`, 10000);
      await delay(200);
    }
    assert.ok(h.notifications.some((n) => /keeps leaving/.test(n.title)));
  });
});

test('the real Poll Everywhere waiting page (captured markup) is recognised as waiting, with its tab buttons ignored', async () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pollev-waiting-page.html'), 'utf8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/examplepresenter`;
  const site = await startMockSite();

  // As captured, the page is signed out: the bot must say so and do nothing.
  const guest = await startBot(site, url);
  try {
    const attention = await guest.waitForEvent('attention');
    assert.equal(attention['reason'], 'signed_out');
    const read = await guest.bot.browser.snapshot();
    assert.ok(read.ok);
    if (read.ok) {
      assert.equal(read.snapshot.adapter, 'pollev');
      assert.equal(read.snapshot.scopeFound, true);
      assert.equal(read.snapshot.signedIn, false);
      assert.equal(read.snapshot.pushConnected, true);
      assert.equal(read.snapshot.liveTabSelected, true);
      assert.equal(read.snapshot.cookieBanner, true);
      assert.equal(read.snapshot.blockingDialog, null);
      assert.equal(read.snapshot.poll, null);
      assert.equal(read.snapshot.unknownControls, 0);
      assert.match(read.snapshot.scopeText, /Waiting for examplepresenter's presentation to begin/);
    }
  } finally {
    await guest.stop().catch(() => undefined);
    cleanup(guest.dir);
  }

  // With the sign-in requirement off, the same page is simply "waiting".
  const anyone = await startBot(site, url, { overrides: { requireSignIn: false } });
  try {
    await anyone.waitForEvent('watching');
    await delay(1200);
    assert.equal(anyone.events('poll.detected').length, 0);
    assert.equal(anyone.events('page.unknown').length, 0);
    assert.equal(anyone.events('attention').length, 0);
  } finally {
    await anyone.stop().catch(() => undefined);
    cleanup(anyone.dir);
    await site.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
