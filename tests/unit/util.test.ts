import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { AGENT_GLOBAL, AGENT_VERSION, installPageAgent, NOTIFY_BINDING } from '../../src/browser/pageAgent.ts';
import { askForUrl, readLastUrl, writeLastUrl } from '../../src/cli/prompt.ts';
import { AbortError, backoffMs, clock, errorMessage, randomInt, sleep, withTimeout } from '../../src/util/time.ts';

test('sleep resolves after the delay and rejects at once when aborted', async () => {
  const start = Date.now();
  await sleep(30);
  assert.ok(Date.now() - start >= 25);

  const controller = new AbortController();
  const pending = sleep(5000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const t = Date.now();
  await assert.rejects(pending, AbortError);
  assert.ok(Date.now() - t < 1000);

  const already = new AbortController();
  already.abort();
  await assert.rejects(sleep(10, already.signal), AbortError);
});

test('withTimeout passes results and errors through and times out slow work', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 100, 'x'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100, 'x'), /boom/);
  await assert.rejects(withTimeout(new Promise(() => undefined), 30, 'reading the page'), /reading the page timed out after 30ms/);
});

test('backoff doubles from the initial delay up to the cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 1000, 30000)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoffMs(-3, 1000, 30000), 1000);
  assert.equal(backoffMs(500, 1000, 30000), 30000);
});

test('randomInt covers the whole range, inclusive, and tolerates swapped bounds', () => {
  assert.equal(randomInt(2000, 8000, () => 0), 2000);
  assert.equal(randomInt(2000, 8000, () => 0.999999), 8000);
  assert.equal(randomInt(5, 5, () => 0.5), 5);
  assert.equal(randomInt(8, 2, () => 0), 2);
  for (let i = 0; i < 200; i += 1) {
    const n = randomInt(1, 3, Math.random);
    assert.ok(n >= 1 && n <= 3 && Number.isInteger(n));
  }
});

test('clock and errorMessage format for people', () => {
  assert.equal(clock(new Date(2026, 9, 2, 8, 5, 9)), '08:05:09');
  assert.equal(errorMessage(new Error('first line\nsecond line')), 'first line');
  assert.equal(errorMessage('plain'), 'plain');
});

test('the page agent agrees with the names the Node side uses', () => {
  const source = installPageAgent.toString();
  assert.ok(source.includes(`'${AGENT_GLOBAL}'`) || source.includes(`"${AGENT_GLOBAL}"`));
  assert.ok(source.includes(`'${NOTIFY_BINDING}'`) || source.includes(`"${NOTIFY_BINDING}"`));
  assert.match(source, new RegExp(`VERSION = ${AGENT_VERSION}\\b`));
});

test('the page agent is self-contained: it installs and reports in a bare context', () => {
  // A minimal stand-in for a browser page with no document body yet. If the function
  // referred to anything outside its own source, running it here would throw.
  const listeners: string[] = [];
  const windowLike: Record<string, unknown> = {
    location: { href: 'https://example.org/x', hostname: 'example.org', pathname: '/x' },
    addEventListener: (name: string) => listeners.push(name),
    getComputedStyle: () => ({ visibility: 'visible' }),
  };
  windowLike['top'] = windowLike;
  const documentLike = {
    title: 'T',
    readyState: 'loading',
    body: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (name: string) => listeners.push(name),
  };
  const context = vm.createContext({
    window: windowLike,
    document: documentLike,
    navigator: { onLine: true },
    performance: { timeOrigin: 1234.4 },
    MutationObserver: class {
      observe(): void {
        listeners.push('observe');
      }
    },
  });
  vm.runInContext(`(${installPageAgent.toString()})({ quietMs: 50 })`, context);
  const agent = windowLike[AGENT_GLOBAL] as { version: number; snapshot(): Record<string, unknown>; resolve(ref: string): unknown };
  assert.equal(agent.version, AGENT_VERSION);
  const snapshot = agent.snapshot();
  assert.equal(snapshot['agentVersion'], AGENT_VERSION);
  assert.equal(snapshot['url'], 'https://example.org/x');
  assert.equal(snapshot['docStartedAt'], 1234);
  assert.equal(snapshot['poll'], null);
  assert.equal(agent.resolve('nope'), null);
  assert.ok(listeners.includes('observe'));
  assert.ok(listeners.includes('result') && listeners.includes('notification:show'));
  // Installing twice is harmless.
  vm.runInContext(`(${installPageAgent.toString()})({ quietMs: 50 })`, context);
  assert.equal(windowLike[AGENT_GLOBAL], agent);
});

test('the last-used link is remembered and read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-state-'));
  try {
    const file = path.join(dir, 'nested', 'state.json');
    assert.equal(readLastUrl(file), null);
    writeLastUrl(file, 'https://pollev.com/someone');
    assert.equal(readLastUrl(file), 'https://pollev.com/someone');
    fs.writeFileSync(file, 'garbage');
    assert.equal(readLastUrl(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function prompt(lastUrl: string | null, typed: string[], end = false): Promise<{ result: string | null; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString();
  });
  const done = askForUrl(lastUrl, { input, output }).then((result) => ({ result, shown }));
  let i = 0;
  const feed = (): void => {
    if (i < typed.length) {
      input.write(`${typed[i]}\n`);
      i += 1;
      setTimeout(feed, 15);
    } else if (end) {
      input.end();
    }
  };
  setTimeout(feed, 15);
  return done;
}

test('the link prompt accepts a pasted link and normalises it', async () => {
  const { result, shown } = await prompt(null, ['pollev.com/someone']);
  assert.equal(result, 'https://pollev.com/someone');
  assert.match(shown, /Paste the poll link/);
});

test('the link prompt reuses the last link on a bare Enter', async () => {
  const { result, shown } = await prompt('https://pollev.com/last', ['']);
  assert.equal(result, 'https://pollev.com/last');
  assert.match(shown, /press Enter to reuse https:\/\/pollev\.com\/last/);
});

test('the link prompt asks again after an empty or unusable answer', async () => {
  const { result, shown } = await prompt(null, ['', 'two words', 'pollev.com/ok']);
  assert.equal(result, 'https://pollev.com/ok');
  assert.match(shown, /Please paste a link/);
  assert.match(shown, /does not look right/);
});

test('the link prompt gives up quietly when input ends', async () => {
  const { result } = await prompt(null, [], true);
  assert.equal(result, null);
});
