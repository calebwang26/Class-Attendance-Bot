import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashText, Logger, makeSessionId, pruneOldFiles } from '../../src/logger/logger.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-log-'));
}

const fixedNow = (): Date => new Date('2026-10-02T12:00:05.000Z');

test('each event is written as one JSON line with timestamp, session, level and name', () => {
  const dir = scratch();
  try {
    const logger = new Logger({ dir, level: 'debug', redactQuestionText: false, sessionId: 's1', print: () => undefined, now: fixedNow });
    logger.info('poll.detected', { question: 'Q?', options: ['A', 'B'] });
    logger.warn('something', { n: 1 });
    const lines = fs.readFileSync(logger.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      ts: '2026-10-02T12:00:05.000Z',
      session: 's1',
      level: 'info',
      event: 'poll.detected',
      question: 'Q?',
      options: ['A', 'B'],
    });
    assert.equal(lines[1]?.['level'], 'warn');
    assert.equal(path.basename(logger.file), 'session-s1.jsonl');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('events below the configured level are dropped', () => {
  const logger = new Logger({ dir: scratch(), level: 'warn', redactQuestionText: false, sessionId: 's', writeFile: false, print: () => undefined });
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  logger.error('d');
  assert.deepEqual(logger.events.map((e) => e.event), ['c', 'd']);
});

test('only events with a message are printed, prefixed by the time and a severity word', () => {
  const lines: string[] = [];
  const logger = new Logger({ dir: scratch(), level: 'debug', redactQuestionText: false, sessionId: 's', writeFile: false, print: (l) => lines.push(l), now: fixedNow });
  logger.info('quiet', { n: 1 });
  logger.info('said', { message: 'Hello' });
  logger.warn('warned', { message: 'Careful' });
  logger.error('failed', { message: 'Broken' });
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? '', /^\d\d:\d\d:\d\d {2}Hello$/);
  assert.match(lines[1] ?? '', /WARNING: Careful$/);
  assert.match(lines[2] ?? '', /ERROR: Broken$/);
  assert.equal(logger.lastMessage, 'Broken');
});

test('credentials and cookies never reach the log, whatever is passed in', () => {
  const dir = scratch();
  try {
    const logger = new Logger({ dir, level: 'debug', redactQuestionText: false, sessionId: 's', print: () => undefined });
    logger.info('x', { cookie: 'a=b', cookies: ['c'], password: 'hunter2', token: 't', Authorization: 'Bearer z', headers: { a: 1 }, 'set-cookie': 'q', fine: 'kept' });
    const text = fs.readFileSync(logger.file, 'utf8');
    assert.ok(!/hunter2|Bearer|a=b/.test(text));
    const event = JSON.parse(text.trim()) as Record<string, unknown>;
    assert.equal(event['fine'], 'kept');
    for (const key of ['cookie', 'cookies', 'password', 'token', 'Authorization', 'headers', 'set-cookie']) {
      assert.ok(!(key in event), `${key} must be dropped`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with redaction on, poll content is replaced by hashes and the message is not stored', () => {
  const dir = scratch();
  try {
    const printed: string[] = [];
    const logger = new Logger({ dir, level: 'debug', redactQuestionText: true, sessionId: 's', print: (l) => printed.push(l) });
    logger.info('poll.detected', {
      question: 'Secret question',
      options: ['Secret A', 'Secret B'],
      response: 'Secret A',
      evidence: '"Secret A" is marked as your vote',
      pageText: 'Secret question Secret A',
      fingerprint: 'abc123',
      message: 'New poll: "Secret question"',
    });
    const text = fs.readFileSync(logger.file, 'utf8');
    assert.ok(!text.includes('Secret'), text);
    const event = JSON.parse(text.trim()) as Record<string, unknown>;
    assert.equal(event['question'], hashText('Secret question'));
    assert.deepEqual(event['options'], [hashText('Secret A'), hashText('Secret B')]);
    assert.equal(event['fingerprint'], 'abc123', 'identifiers are kept');
    assert.ok(!('message' in event));
    assert.equal(printed.length, 1, 'the terminal still shows the message');
    assert.match(printed[0] ?? '', /Secret question/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hashText is stable and does not reveal the text', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.match(hashText('abc'), /^sha256:[0-9a-f]{16}$/);
});

test('a log file that cannot be written does not stop the bot', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = scratch();
  try {
    const printed: string[] = [];
    const logger = new Logger({ dir, level: 'debug', redactQuestionText: false, sessionId: 's', print: (l) => printed.push(l) });
    logger.info('one');
    fs.chmodSync(logger.file, 0o400);
    logger.info('two');
    logger.info('three');
    assert.deepEqual(logger.events.map((e) => e.event), ['one', 'two', 'three']);
    assert.equal(printed.filter((l) => /cannot write the log file/.test(l)).length, 1, 'warned once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('makeSessionId is a sortable local date and time, safe for file names', () => {
  const id = makeSessionId(new Date(2026, 9, 2, 8, 1, 12));
  assert.equal(id, '2026-10-02_080112');
  assert.match(makeSessionId(), /^\d{4}-\d{2}-\d{2}_\d{6}$/);
});

test('pruneOldFiles removes only files older than the retention period', () => {
  const dir = scratch();
  try {
    const old = path.join(dir, 'old.jsonl');
    const recent = path.join(dir, 'recent.jsonl');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(recent, 'y');
    fs.mkdirSync(path.join(dir, 'sub'));
    const now = new Date('2026-10-02T00:00:00Z');
    fs.utimesSync(old, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    fs.utimesSync(recent, new Date('2026-09-25T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    assert.equal(pruneOldFiles(dir, 30, now), 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['recent.jsonl', 'sub']);
    assert.equal(pruneOldFiles(dir, 0, now), 0, 'zero means keep everything');
    assert.equal(pruneOldFiles(path.join(dir, 'missing'), 30, now), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
