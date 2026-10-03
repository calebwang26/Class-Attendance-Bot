import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

test('the bot runs until it is stopped, and the summary matches what happened', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'One', options: PLANETS });
    await h.waitForEvent('poll.answered');
    site.activate({ title: 'Two' });
    await h.until(() => h.events('poll.answered').length === 2, 'second answer');
    site.activate({ title: 'Three', options: PLANETS, type: 'ranking_poll' });
    await h.waitForEvent('poll.unsupported');
    const summary = await h.stop();
    assert.equal(summary.detected, 3);
    assert.equal(summary.answered, 2);
    assert.equal(summary.unsupported, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.stopReason, 'test finished');
    assert.ok(Date.parse(summary.stoppedAt) >= Date.parse(summary.startedAt));
    assert.equal(h.bot.currentState, 'STOPPED');
  });
});

test('an optional time limit stops the bot by itself', async () => {
  await withBot({ overrides: { stopAfterMinutes: 0.03 } }, async (h) => {
    await h.until(() => h.bot.currentState === 'STOPPED', 'the time limit', 8000);
    const summary = await h.stop();
    assert.match(summary.stopReason, /limit was reached/);
  });
});

test('stopping during the response delay is prompt and sends nothing', async () => {
  await withBot({ overrides: { response: { delayMs: { min: 20000, max: 20000 } } } }, async (h, site) => {
    site.activate({ title: 'Slow', options: PLANETS });
    await h.waitForEvent('poll.detected');
    const start = Date.now();
    await h.stop();
    assert.ok(Date.now() - start < 3000, `stop took ${Date.now() - start} ms`);
    assert.equal(site.attempts.length, 0);
  });
});

test('the log file is one JSON event per line, each with a timestamp, session id, level and event name', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Logged', options: PLANETS });
    await h.waitForEvent('poll.answered');
    await h.stop();
    const lines = fs.readFileSync(h.logger.file, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 5);
    const names = new Set<string>();
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      assert.equal(typeof event['ts'], 'string');
      assert.ok(!Number.isNaN(Date.parse(String(event['ts']))));
      assert.equal(event['session'], h.logger.sessionId);
      assert.ok(['debug', 'info', 'warn', 'error'].includes(String(event['level'])));
      assert.equal(typeof event['event'], 'string');
      names.add(String(event['event']));
    }
    for (const expected of ['session.start', 'page.opened', 'poll.detected', 'poll.responding', 'poll.answered', 'session.stop']) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }
    const whole = lines.join('\n');
    assert.ok(!/cookie=|mock_participant|set-cookie|password/i.test(whole), 'no credentials or cookies in the log');
  });
});

test('with redaction on, neither the log nor the answered-polls file contains question or option text', async () => {
  await withBot({ overrides: { logging: { redactQuestionText: true } } }, async (h, site) => {
    site.activate({ title: 'A very secret question', options: ['Classified one', 'Classified two'] });
    await h.waitForEvent('poll.answered');
    site.activate({ title: 'Another secret prompt' });
    await h.until(() => h.events('poll.answered').length === 2, 'second answer');
    await h.stop();
    const log = fs.readFileSync(h.logger.file, 'utf8');
    const store = fs.readFileSync(h.config.dedupe.file, 'utf8');
    for (const secret of ['very secret question', 'Classified one', 'Classified two', 'Another secret prompt']) {
      assert.ok(!log.includes(secret), `log contains "${secret}"`);
      assert.ok(!store.includes(secret), `store contains "${secret}"`);
    }
    assert.match(log, /sha256:[0-9a-f]{16}/);
  });
});

test('the answered-polls file records each answer with a fingerprint and timestamp', async () => {
  await withBot({}, async (h, site) => {
    site.activate({ title: 'Recorded', options: PLANETS });
    const answered = await h.waitForEvent('poll.answered');
    await delay(100);
    const data = JSON.parse(fs.readFileSync(h.config.dedupe.file, 'utf8')) as { version: number; entries: Record<string, unknown>[] };
    assert.equal(data.version, 1);
    assert.equal(data.entries.length, 1);
    const entry = data.entries[0];
    assert.ok(entry);
    assert.equal(entry['fingerprint'], answered['fingerprint']);
    assert.equal(entry['outcome'], 'answered');
    assert.equal(entry['pageShowedAnswered'], true);
    assert.equal(entry['response'], 'Mercury');
    assert.ok(!Number.isNaN(Date.parse(String(entry['at']))));
  });
});
