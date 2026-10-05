import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELP, parseCliArgs, UsageError } from '../../src/cli/args.ts';

test('no arguments means: run, and ask for the link and the lecture times', () => {
  assert.deepEqual(parseCliArgs([]), { mode: 'run', url: null, configPath: null, hours: null, overrides: {} });
});

test('--hours and --any-time answer the lecture-times question; both at once is an error', () => {
  assert.equal(parseCliArgs(['x', '--hours', 'Mon 8-9']).hours, 'Mon 8-9');
  assert.equal(parseCliArgs(['x', '--any-time']).hours, 'any');
  assert.throws(() => parseCliArgs(['x', '--hours', 'Mon 8-9', '--any-time']), /either --hours or --any-time/);
  assert.throws(() => parseCliArgs(['x', '--hours', '  ']), /--hours needs your lecture times/);
});

test('a link can be given as the only positional argument', () => {
  const args = parseCliArgs(['pollev.com/someone']);
  assert.equal(args.mode, 'run');
  assert.equal(args.url, 'pollev.com/someone');
});

test('flags become configuration overrides', () => {
  const args = parseCliArgs([
    'https://pollev.com/x',
    '--dry-run',
    '--choice',
    'first',
    '--free-text',
    'echo_question',
    '--text',
    'hello there',
    '--stop-after',
    '90',
    '--chrome',
    '--headless',
    '--no-keep-awake',
    '--allow-guest',
    '--config',
    'my.json',
  ]);
  assert.equal(args.configPath, 'my.json');
  assert.deepEqual(args.overrides, {
    dryRun: true,
    response: { multipleChoice: 'first', freeText: 'echo_question', fixedText: 'hello there' },
    stopAfterMinutes: 90,
    browser: { channel: 'chrome', headless: true },
    keepAwake: false,
    requireSignIn: false,
  });
});

test('--login, --help and --version select the mode', () => {
  assert.equal(parseCliArgs(['--login', 'pollev.com/x']).mode, 'login');
  assert.equal(parseCliArgs(['--help']).mode, 'help');
  assert.equal(parseCliArgs(['-h']).mode, 'help');
  assert.equal(parseCliArgs(['--version']).mode, 'version');
});

test('mistakes are reported as usage errors', () => {
  assert.throws(() => parseCliArgs(['--no-such-flag']), UsageError);
  assert.throws(() => parseCliArgs(['a', 'b']), /Expected one link/);
  assert.throws(() => parseCliArgs(['--stop-after', 'soon']), /needs a number of minutes/);
  assert.throws(() => parseCliArgs(['--text']), UsageError);
});

test('the help text mentions every flag the parser accepts', () => {
  for (const flag of ['--dry-run', '--choice', '--free-text', '--text', '--stop-after', '--chrome', '--headless', '--allow-guest', '--no-keep-awake', '--config', '--help', '--version']) {
    assert.ok(HELP.includes(flag), `help is missing ${flag}`);
  }
  assert.match(HELP, /npm run login/);
});
