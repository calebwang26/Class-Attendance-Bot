import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildConfig, ConfigError, DEFAULT_CONFIG, normalizeUrl, readConfigFile, resolvePath } from '../../src/config/config.ts';

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

test('with no input the configuration is the defaults, as a separate copy', () => {
  const config = buildConfig();
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config.response, DEFAULT_CONFIG.response);
});

test('the defaults are the choices the project owner made', () => {
  const config = buildConfig();
  assert.equal(config.response.multipleChoice, 'random');
  assert.equal(config.response.freeText, 'fixed_text');
  assert.equal(config.response.fixedText, 'value');
  assert.deepEqual(config.response.delayMs, { min: 2000, max: 8000 });
  assert.equal(config.stopAfterMinutes, null, 'runs until stopped: no time limit');
  assert.equal(config.url, null, 'the link is supplied at start, not built in');
  assert.equal(config.dryRun, false);
  assert.equal(config.browser.headless, false, 'a visible browser window');
  assert.equal(config.requireSignIn, true);
});

test('later layers override earlier ones and leave sibling settings alone', () => {
  const config = buildConfig({ response: { fixedText: 'one', maxAttempts: 5 } }, { response: { fixedText: 'two' } });
  assert.equal(config.response.fixedText, 'two');
  assert.equal(config.response.maxAttempts, 5);
  assert.equal(config.response.multipleChoice, 'random');
  assert.equal(config.monitor.debounceMs, DEFAULT_CONFIG.monitor.debounceMs);
});

test('building a configuration never changes the defaults', () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  buildConfig({ response: { delayMs: { min: 1, max: 2 } }, monitor: { recovery: { initialMs: 60, maxMs: 70 } } });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
});

test('undefined and null layers are ignored', () => {
  assert.deepEqual(buildConfig(undefined, null, {}), DEFAULT_CONFIG);
});

test('an unknown setting is rejected by name, which catches typos', () => {
  const problems = problemsOf(() => buildConfig({ response: { fixedTxt: 'x' } }));
  assert.deepEqual(problems, ['response.fixedTxt is not a known setting']);
});

test('wrong types, out-of-range numbers and bad choices are all reported together', () => {
  const problems = problemsOf(() =>
    buildConfig({
      dryRun: 'yes',
      response: { multipleChoice: 'best', confirmTimeoutMs: 10, maxAttempts: 2.5, fixedText: '   ' },
      monitor: { debounceMs: '250' },
    }),
  );
  assert.ok(problems.includes('dryRun must be true or false'));
  assert.ok(problems.some((p) => p.startsWith('response.multipleChoice must be one of:')));
  assert.ok(problems.includes('response.confirmTimeoutMs must be at least 500'));
  assert.ok(problems.includes('response.maxAttempts must be a whole number'));
  assert.ok(problems.includes('response.fixedText must not be empty'));
  assert.ok(problems.includes('monitor.debounceMs must be a number'));
  assert.equal(problems.length, 6);
});

test('null is accepted only where a setting can be switched off', () => {
  assert.equal(buildConfig({ stopAfterMinutes: null }).stopAfterMinutes, null);
  assert.equal(buildConfig({ browser: { channel: null } }).browser.channel, null);
  assert.deepEqual(problemsOf(() => buildConfig({ keepAwake: null })), ['keepAwake must not be null']);
  assert.deepEqual(problemsOf(() => buildConfig({ response: { fixedText: null } })), ['response.fixedText must not be null']);
});

test('a section given as something other than an object is rejected', () => {
  assert.deepEqual(problemsOf(() => buildConfig({ response: 'fast' })), ['response must be an object']);
  assert.deepEqual(problemsOf(() => buildConfig([1, 2])), ['config must be an object']);
});

test('a delay whose minimum exceeds its maximum is rejected', () => {
  const problems = problemsOf(() => buildConfig({ response: { delayMs: { min: 5000, max: 1000 } } }));
  assert.deepEqual(problems, ['response.delayMs.min must not be greater than response.delayMs.max']);
});

test('a recovery backoff whose start exceeds its cap is rejected', () => {
  const problems = problemsOf(() => buildConfig({ monitor: { recovery: { initialMs: 9000, maxMs: 1000 } } }));
  assert.deepEqual(problems, ['monitor.recovery.initialMs must not be greater than monitor.recovery.maxMs']);
});

test('a link in the configuration is normalised, and a bad one is rejected', () => {
  assert.equal(buildConfig({ url: 'pollev.com/someone' }).url, 'https://pollev.com/someone');
  const problems = problemsOf(() => buildConfig({ url: 'ftp://example.com/x' }));
  assert.equal(problems.length, 1);
  assert.match(String(problems[0]), /^url: /);
});

test('normalizeUrl accepts what a person would paste or type', () => {
  assert.equal(normalizeUrl('https://pollev.com/examplepresenter'), 'https://pollev.com/examplepresenter');
  assert.equal(normalizeUrl('  https://pollev.com/examplepresenter  '), 'https://pollev.com/examplepresenter');
  assert.equal(normalizeUrl('pollev.com/examplepresenter'), 'https://pollev.com/examplepresenter');
  assert.equal(normalizeUrl('PollEv.com/ExamplePresenter'), 'https://pollev.com/ExamplePresenter');
  assert.equal(normalizeUrl('examplepresenter'), 'https://pollev.com/examplepresenter');
  assert.equal(normalizeUrl('some_presenter-2'), 'https://pollev.com/some_presenter-2');
  assert.equal(normalizeUrl('http://127.0.0.1:4173/pollev/demo'), 'http://127.0.0.1:4173/pollev/demo');
  assert.equal(normalizeUrl('localhost:4173/pollev/demo'), 'http://localhost:4173/pollev/demo');
  assert.equal(normalizeUrl('127.0.0.1:4173/pollev/demo'), 'http://127.0.0.1:4173/pollev/demo');
  assert.equal(normalizeUrl('example.org/poll?id=7'), 'https://example.org/poll?id=7');
});

test('normalizeUrl rejects things that are not links to a web page', () => {
  for (const bad of ['', '   ', 'two words', 'ftp://example.com/x', 'file:///etc/passwd', 'javascript://alert(1)', 'https://', 'http://nodot/x']) {
    assert.throws(() => normalizeUrl(bad), Error, `should reject ${JSON.stringify(bad)}`);
  }
});

test('readConfigFile returns undefined for a missing file and explains a broken one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-config-'));
  try {
    assert.equal(readConfigFile(path.join(dir, 'nope.json')), undefined);
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, '{"dryRun": true}');
    assert.deepEqual(readConfigFile(good), { dryRun: true });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{dryRun: true');
    const problems = problemsOf(() => readConfigFile(bad));
    assert.match(String(problems[0]), /is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePath keeps absolute paths and anchors relative ones', () => {
  assert.equal(resolvePath('/tmp/x'), '/tmp/x');
  assert.equal(resolvePath('logs', '/base'), path.resolve('/base', 'logs'));
});
