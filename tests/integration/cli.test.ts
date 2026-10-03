import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, makeScratchDir, PLANETS, startMockSite, waitUntil } from '../helpers/harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');

interface Run {
  code: number | null;
  out: string;
}

/** Runs the bot's command line as a separate process, the way a person would. */
function run(args: string[], options: { stdin?: string; onOutput?: (soFar: string, kill: (signal: NodeJS.Signals) => void) => void; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`command timed out. Output so far:\n${out}`));
    }, options.timeoutMs ?? 60000);
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      options.onOutput?.(out, (signal) => child.kill(signal));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

/** A settings file that keeps every file the bot writes inside a scratch directory, and runs fast. */
function writeSettings(dir: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      keepAwake: false,
      browser: { headless: true, profileDir: path.join(dir, 'profile') },
      dedupe: { file: path.join(dir, 'data', 'answered.json') },
      logging: { dir: path.join(dir, 'logs') },
      notify: { desktop: false, sound: false, remindMs: 0 },
      response: { multipleChoice: 'first', delayMs: { min: 50, max: 100 } },
      monitor: { settleMs: 150, debounceMs: 50, fallbackPollMs: 400 },
      ...extra,
    }),
  );
  return file;
}

test('--help prints usage and exits 0', async () => {
  const { code, out } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(out, /Usage/);
  assert.match(out, /npm start -- <link>/);
  assert.match(out, /Ctrl\+C/);
});

test('--version prints the version from package.json', async () => {
  const { code, out } = await run(['--version']);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(code, 0);
  assert.equal(out.trim(), pkg.version);
});

test('an unknown flag exits 2 and shows the usage', async () => {
  const { code, out } = await run(['--frobnicate']);
  assert.equal(code, 2);
  assert.match(out, /frobnicate/);
  assert.match(out, /Usage/);
});

test('a bad setting on the command line is explained and exits 2', async () => {
  const { code, out } = await run(['pollev.com/x', '--choice', 'best']);
  assert.equal(code, 2);
  assert.match(out, /response\.multipleChoice must be one of: random, first, last, skip/);
});

test('a settings file with a mistake is explained and exits 2', async () => {
  const dir = makeScratchDir();
  try {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ respnse: {} }));
    const { code, out } = await run(['pollev.com/x', '--config', file]);
    assert.equal(code, 2);
    assert.match(out, /respnse is not a known setting/);
    const missing = await run(['pollev.com/x', '--config', path.join(dir, 'nope.json')]);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /does not exist/);
  } finally {
    cleanup(dir);
  }
});

test('a link that is not a link is rejected before anything starts', async () => {
  const { code, out } = await run(['two words']);
  assert.equal(code, 2);
  assert.match(out, /does not look right/);
});

test('with no link and no terminal to ask at, it says how to give one and exits 2', async () => {
  const dir = makeScratchDir();
  try {
    const { code, out } = await run(['--config', writeSettings(dir)]);
    assert.equal(code, 2);
    assert.match(out, /npm start -- <link>/);
  } finally {
    cleanup(dir);
  }
});

test('a full run from the command line: answers the poll, stops at the time limit, prints a summary', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    const id = site.activate({ title: 'From the command line', options: PLANETS });
    const { code, out } = await run([site.participantUrl(), '--config', writeSettings(dir), '--stop-after', '0.06'], { timeoutMs: 90000 });
    assert.equal(code, 0, out);
    assert.match(out, /Poll bot/);
    assert.match(out, new RegExp(`Link:\\s+${site.participantUrl().replace(/[/.]/g, '\\$&')}`));
    assert.match(out, /multiple choice → the first option; free text → "value"/);
    assert.match(out, /New poll: "From the command line" \(4 options\)/);
    assert.match(out, /Answered "Mercury" — confirmed/);
    assert.match(out, /Session summary/);
    assert.match(out, /Polls seen:\s+1/);
    assert.match(out, /Answered:\s+1/);
    assert.match(out, /Could not answer:\s+0/);
    assert.match(out, /limit was reached/);
    assert.equal(site.responsesFor(id).length, 1);

    const logs = fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.endsWith('.jsonl'));
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /^session-\d{4}-\d{2}-\d{2}_\d{6}\.jsonl$/);
    assert.ok(fs.existsSync(path.join(dir, 'data', 'answered.json')));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8')) as { lastUrl: string };
    assert.equal(state.lastUrl, site.participantUrl(), 'the link is remembered for next time');
  } finally {
    await site.close();
    cleanup(dir);
  }
});

test('Ctrl+C stops the bot cleanly with a summary', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    let sent = false;
    const { code, out } = await run([site.participantUrl(), '--config', writeSettings(dir)], {
      timeoutMs: 90000,
      onOutput: (soFar, kill) => {
        if (!sent && /no poll is showing/.test(soFar)) {
          sent = true;
          kill('SIGINT');
        }
      },
    });
    assert.equal(code, 0, out);
    assert.match(out, /Session summary/);
    assert.match(out, /stopped from the terminal \(Ctrl\+C\)/);
    // The browser was shut down cleanly (Chromium removes its profile lock only then),
    // so a sign-in made just before stopping is kept.
    assert.ok(!fs.existsSync(path.join(dir, 'profile', 'SingletonLock')), 'browser profile closed cleanly');
  } finally {
    await site.close();
    cleanup(dir);
  }
});

test('--dry-run from the command line sends nothing and says so', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    site.activate({ title: 'Only looking', options: PLANETS });
    const { code, out } = await run([site.participantUrl(), '--dry-run', '--config', writeSettings(dir), '--stop-after', '0.05'], { timeoutMs: 90000 });
    assert.equal(code, 0, out);
    assert.match(out, /DRY RUN/);
    assert.match(out, /Dry run: would answer "Mercury"/);
    assert.equal(site.attempts.length, 0);
  } finally {
    await site.close();
    cleanup(dir);
  }
});

test('a second copy on the same browser profile is refused at once with a clear message', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  let killFirst: ((signal: NodeJS.Signals) => void) | null = null;
  try {
    const settings = writeSettings(dir);
    let second: Run | null = null;
    let started = false;
    const first = run([site.participantUrl(), '--config', settings], {
      timeoutMs: 90000,
      onOutput: (soFar, kill) => {
        killFirst = kill;
        if (!started && /no poll is showing/.test(soFar)) {
          started = true;
          const t = Date.now();
          void run([site.participantUrl(), '--config', settings], { timeoutMs: 60000 }).then((r) => {
            second = { ...r, out: `${r.out}\n(took ${Date.now() - t} ms)` };
          });
        }
      },
    });
    await waitUntil(() => second !== null, 'the second copy to give up', 30000);
    const result = second as unknown as Run;
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /Another copy of the bot is already running/);
    const took = Number(/took (\d+) ms/.exec(result.out)?.[1]);
    assert.ok(took < 5000, `refusing took ${took} ms`);
    (killFirst as unknown as (signal: NodeJS.Signals) => void)('SIGINT');
    killFirst = null;
    const firstResult = await first;
    assert.equal(firstResult.code, 0, firstResult.out);
    assert.ok(!fs.existsSync(path.join(dir, 'profile.lock')), 'the lock is released on exit');
  } finally {
    if (killFirst) (killFirst as (signal: NodeJS.Signals) => void)('SIGKILL');
    await site.close();
    cleanup(dir);
  }
});

test('--login opens the browser on the link, explains what to do, and ends cleanly', async () => {
  const site = await startMockSite();
  const dir = makeScratchDir();
  try {
    let sent = false;
    const { code, out } = await run(['--login', site.participantUrl(), '--config', writeSettings(dir)], {
      timeoutMs: 60000,
      onOutput: (soFar, kill) => {
        if (!sent && /Close the browser window when you are done/.test(soFar)) {
          sent = true;
          // Give the page a moment to load, then stop as a person closing the window would.
          setTimeout(() => kill('SIGINT'), 1500);
        }
      },
    });
    assert.equal(code, 0, out);
    assert.match(out, /Sign in there/);
    assert.match(out, /Browser closed/);
    assert.ok(site.pageLoads >= 1, 'the link was opened');
    assert.equal(site.attempts.length, 0, 'nothing was answered in login mode');
    assert.ok(!fs.existsSync(path.join(dir, 'profile.lock')), 'the lock is released');
  } finally {
    await site.close();
    cleanup(dir);
  }
});
