import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AnsweredStore, type AnsweredEntry } from '../../src/dedupe/store.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-store-'));
}

const entry = (over: Partial<AnsweredEntry> = {}): AnsweredEntry => ({
  fingerprint: 'abc',
  kind: 'multiple_choice',
  at: new Date('2026-10-02T12:00:00Z').toISOString(),
  outcome: 'answered',
  pageShowedAnswered: true,
  url: 'https://pollev.com/someone',
  ...over,
});

test('a new store creates its file and directory, empty', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'nested', 'answered.json');
    const { store, quarantinedTo, pruned } = AnsweredStore.open(file, { retainDays: 30 });
    assert.equal(store.size, 0);
    assert.equal(quarantinedTo, null);
    assert.equal(pruned, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, entries: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded answers survive closing and reopening', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'answered.json');
    const now = new Date('2026-10-02T12:30:00Z');
    const first = AnsweredStore.open(file, { retainDays: 30, now }).store;
    assert.equal(first.record(entry({ question: 'Q?', response: 'A' })), true);
    assert.equal(first.record(entry({ fingerprint: 'def', kind: 'free_text' })), true);

    const second = AnsweredStore.open(file, { retainDays: 30, now }).store;
    assert.equal(second.size, 2);
    const found = second.latest('abc', 0);
    assert.ok(found);
    assert.equal(found.question, 'Q?');
    assert.equal(found.response, 'A');
    assert.equal(second.latest('nope', 0), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latest() returns the newest entry within the time window', () => {
  const dir = scratch();
  try {
    const { store } = AnsweredStore.open(path.join(dir, 'a.json'), { retainDays: 0 });
    store.record(entry({ at: '2026-10-01T08:00:00.000Z', response: 'old' }));
    store.record(entry({ at: '2026-10-02T08:00:00.000Z', response: 'new' }));
    assert.equal(store.latest('abc', 0)?.response, 'new');
    assert.equal(store.latest('abc', Date.parse('2026-10-02T07:00:00Z'))?.response, 'new');
    assert.equal(store.latest('abc', Date.parse('2026-10-02T09:00:00Z')), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entries older than the retention period are dropped on open', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'a.json');
    const writer = AnsweredStore.open(file, { retainDays: 0 }).store;
    writer.record(entry({ fingerprint: 'old', at: '2026-08-01T00:00:00.000Z' }));
    writer.record(entry({ fingerprint: 'recent', at: '2026-09-30T00:00:00.000Z' }));
    const { store, pruned } = AnsweredStore.open(file, { retainDays: 30, now: new Date('2026-10-02T00:00:00Z') });
    assert.equal(pruned, 1);
    assert.equal(store.size, 1);
    assert.equal(store.latest('old', 0), undefined);
    assert.ok(store.latest('recent', 0));
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: unknown[] }).entries.length, 1, 'the file is pruned too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable store file is moved aside and a fresh store started', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'answered.json');
    for (const broken of ['{"version":1,"entries":[', 'not json at all', '{"entries":"nope"}', 'null', '[]']) {
      fs.writeFileSync(file, broken);
      const { store, quarantinedTo } = AnsweredStore.open(file, { retainDays: 30 });
      assert.equal(store.size, 0);
      assert.ok(quarantinedTo, `quarantined for ${broken}`);
      assert.equal(fs.readFileSync(quarantinedTo, 'utf8'), broken, 'the original content is kept');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, entries: [] });
      fs.rmSync(quarantinedTo);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed entries inside an otherwise valid file are ignored, the rest kept', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'answered.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [entry(), { fingerprint: 'x' }, 'junk', null, entry({ fingerprint: 'ok2', at: 'not a date' }), entry({ fingerprint: 'ok3' })] }),
    );
    const { store, quarantinedTo } = AnsweredStore.open(file, { retainDays: 0 });
    assert.equal(quarantinedTo, null);
    assert.equal(store.size, 2);
    assert.ok(store.latest('abc', 0));
    assert.ok(store.latest('ok3', 0));
    assert.equal(store.latest('ok2', 0), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markPageShowedAnswered updates the newest entry for that poll and saves it', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'answered.json');
    const { store } = AnsweredStore.open(file, { retainDays: 0 });
    store.record(entry({ pageShowedAnswered: false }));
    assert.equal(store.markPageShowedAnswered('abc'), true);
    assert.equal(store.latest('abc', 0)?.pageShowedAnswered, true);
    assert.equal(AnsweredStore.open(file, { retainDays: 0 }).store.latest('abc', 0)?.pageShowedAnswered, true);
    assert.equal(store.markPageShowedAnswered('unknown'), true, 'nothing to do is not an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('when the file cannot be written, record() says so and still remembers the entry', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = scratch();
  try {
    const sub = path.join(dir, 'locked');
    const file = path.join(sub, 'answered.json');
    const { store } = AnsweredStore.open(file, { retainDays: 0 });
    fs.chmodSync(sub, 0o500);
    try {
      assert.equal(store.record(entry()), false);
      assert.equal(store.writable, false);
      assert.ok(store.latest('abc', 0), 'kept in memory');
      assert.equal(store.size, 1);
    } finally {
      fs.chmodSync(sub, 0o700);
    }
    assert.equal(store.record(entry({ fingerprint: 'later' })), true, 'writing resumes once the folder is writable');
    assert.equal(store.writable, true);
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: unknown[] }).entries.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a store in a place that cannot be written fails up front', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = scratch();
  try {
    fs.chmodSync(dir, 0o500);
    assert.throws(() => AnsweredStore.open(path.join(dir, 'answered.json'), { retainDays: 0 }));
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writes leave no temporary file behind', () => {
  const dir = scratch();
  try {
    const { store } = AnsweredStore.open(path.join(dir, 'answered.json'), { retainDays: 0 });
    store.record(entry());
    assert.deepEqual(fs.readdirSync(dir), ['answered.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
