import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delay, PLANETS, withBot } from '../helpers/harness.ts';

/**
 * A scripted class session against the mock site: polls at irregular
 * intervals, mostly multiple choice, with the faults a real morning might
 * bring. By default it is compressed into about three minutes; set
 * SOAK_MINUTES=90 for a full-length run.
 *
 * Pass criteria: every poll gets exactly one response per round, nothing
 * fails, and the page's memory does not keep growing.
 */
const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 3);
const TOTAL_MS = MINUTES * 60 * 1000;

// A small deterministic random source so a failing run can be repeated.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test(`soak: a ${MINUTES}-minute session with faults answers every poll exactly once`, { timeout: TOTAL_MS + 10 * 60 * 1000 }, async () => {
  const rand = seeded(20261002);
  const polls = Math.max(12, Math.round(MINUTES * 0.25));
  const gap = TOTAL_MS / polls;

  await withBot(
    {
      overrides: {
        response: { multipleChoice: 'random', delayMs: { min: 200, max: 1500 } },
        monitor: { resyncMs: Math.max(20000, Math.round(gap * 2)) },
      },
      rng: rand,
    },
    async (h, site) => {
      const page = h.bot.browser.page;
      assert.ok(page);
      const heap = async (): Promise<number> => {
        const current = h.bot.browser.page;
        if (!current) return 0;
        const session = await current.context().newCDPSession(current);
        try {
          await session.send('Performance.enable');
          const { metrics } = await session.send('Performance.getMetrics');
          return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
        } finally {
          await session.detach().catch(() => undefined);
        }
      };

      const ids: string[] = [];
      let clearedId: string | null = null;
      let earlyHeap = 0;
      const started = Date.now();

      for (let i = 0; i < polls; i += 1) {
        const freeText = rand() < 0.2;
        const title = `Soak question ${i + 1}: ${freeText ? 'say a word' : 'pick one'}`;
        const id = freeText ? site.activate({ title }) : site.activate({ title, options: PLANETS.slice(0, 2 + Math.floor(rand() * 3)) });
        ids.push(id);
        const answeredBefore = h.events('poll.answered').length;

        // Faults, spread through the session.
        if (i === 2) site.faults.failSubmits = 1;
        if (i === 4) {
          await delay(300);
          site.forceReload();
        }
        if (i === 6) {
          await page.context().setOffline(true);
          await delay(3000);
          await page.context().setOffline(false);
        }
        if (i === 8) site.dropPush(false);

        await h.until(() => h.events('poll.answered').length > answeredBefore, `poll ${i + 1} to be answered`, 60000);

        // A re-vote on one poll: the presenter clears the responses.
        if (i === 9) {
          clearedId = id;
          const before = h.events('poll.answered').length;
          site.clearResponses();
          await h.until(() => h.events('poll.answered').length > before, 're-vote to be answered', 60000);
        }

        if (i === 1) earlyHeap = await heap();

        // Some polls end on the waiting screen, others are replaced directly by the next.
        const remaining = started + gap * (i + 1) - Date.now();
        if (rand() < 0.5) {
          await delay(Math.max(0, remaining / 2));
          site.deactivate();
          await delay(Math.max(0, remaining / 2));
        } else {
          await delay(Math.max(0, remaining));
        }
      }

      await delay(1500);
      const lateHeap = await heap();
      const summary = await h.stop();

      for (const id of ids) {
        const rounds = new Map<number, number>();
        for (const entry of site.ledger.filter((e) => e.pollId === id)) rounds.set(entry.round, (rounds.get(entry.round) ?? 0) + 1);
        const expected = id === clearedId ? 2 : 1;
        assert.equal(rounds.size, expected, `poll ${id} answered in ${rounds.size} round(s)`);
        for (const [round, count] of rounds) assert.equal(count, 1, `poll ${id} round ${round} got ${count} responses`);
      }
      assert.equal(site.ledger.length, polls + 1);
      assert.equal(summary.failed, 0);
      assert.equal(summary.answered, polls + 1);
      assert.equal(h.events('poll.failed').length, 0);
      assert.ok(earlyHeap > 0 && lateHeap > 0);
      assert.ok(lateHeap < earlyHeap * 3, `page heap grew from ${earlyHeap} to ${lateHeap}`);
      process.stdout.write(
        `# soak: ${polls} polls (+1 re-vote) in ${Math.round((Date.now() - started) / 1000)} s; ` +
          `${summary.recoveries} recoveries; page heap ${Math.round(earlyHeap / 1e6)} MB -> ${Math.round(lateHeap / 1e6)} MB; ` +
          `node heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB\n`,
      );
    },
  );
});
