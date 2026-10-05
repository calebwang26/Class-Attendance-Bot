import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  askForLectureHours,
  readLastUrl,
  readRecentHours,
  rememberHours,
  RECENT_HOURS_KEPT,
  writeLastUrl,
  type LectureChoice,
} from '../../src/cli/prompt.ts';
import {
  describeLectureHours,
  describeMoment,
  isLectureTime,
  meansAnyTime,
  nextLectureStart,
  parseLectureHours,
  type LectureHours,
} from '../../src/schedule/lectureHours.ts';

function read(text: string): string {
  const r = parseLectureHours(text);
  return r.ok ? describeLectureHours(r.hours) : `ERROR: ${r.error}`;
}

function hours(text: string): LectureHours {
  const r = parseLectureHours(text);
  if (!r.ok) throw new Error(r.error);
  return r.hours;
}

/** 5 October 2026 is a Monday. */
const at = (day: number, h: number, m: number): Date => new Date(2026, 9, day, h, m);

test('lecture times: the ways people write days', () => {
  assert.equal(read('Mon Wed Fri 8:00-9:30'), 'Mon Wed Fri 8:00am–9:30am');
  assert.equal(read('MWF 8-9:30'), 'Mon Wed Fri 8:00am–9:30am');
  assert.equal(read('Mon, Wed, Fri 8:00 - 9:30'), 'Mon Wed Fri 8:00am–9:30am');
  assert.equal(read('Monday and Wednesday at 8:00am-9:30am'), 'Mon Wed 8:00am–9:30am');
  assert.equal(read('Mo We Fr 8-9:30'), 'Mon Wed Fri 8:00am–9:30am');
  assert.equal(read('Tue/Thu 2:00pm-3:30pm'), 'Tue Thu 2:00pm–3:30pm');
  assert.equal(read('TTh 2-3:30pm'), 'Tue Thu 2:00pm–3:30pm');
  assert.equal(read('TuTh 2-3:30pm'), 'Tue Thu 2:00pm–3:30pm');
  assert.equal(read('MTWRF 9-10'), 'Mon–Fri 9:00am–10:00am');
  assert.equal(read('Mon-Fri 8 to 9:30'), 'Mon–Fri 8:00am–9:30am');
  assert.equal(read('weekdays 10:10-11'), 'Mon–Fri 10:10am–11:00am');
  assert.equal(read('Tuesdays from 3:30pm to 5pm'), 'Tue 3:30pm–5:00pm');
  assert.equal(read('Sat Sun 10-11'), 'Sat Sun 10:00am–11:00am');
});

test('lecture times: no days means every day; several blocks; a block without days repeats the days before it', () => {
  assert.equal(read('8:00-9:30'), 'Every day 8:00am–9:30am');
  assert.equal(read('every day 8-9'), 'Every day 8:00am–9:00am');
  assert.equal(read('Mon 8:00-9:30, Thu 14:00-15:20'), 'Mon 8:00am–9:30am, Thu 2:00pm–3:20pm');
  assert.equal(read('Mon 8-9, 13:00-14:00'), 'Mon 8:00am–9:00am, Mon 1:00pm–2:00pm');
});

test('lecture times: how hours are read', () => {
  assert.equal(read('8.00–9.30'), 'Every day 8:00am–9:30am');
  assert.equal(read('11-12:15pm'), 'Every day 11:00am–12:15pm');
  assert.equal(read('11am-12:15'), 'Every day 11:00am–12:15pm');
  assert.equal(read('10-1'), 'Every day 10:00am–1:00pm');
  assert.equal(read('12-1:30'), 'Every day 12:00pm–1:30pm');
  assert.equal(read('07:00-08:30'), 'Every day 7:00am–8:30am');
  assert.equal(read('22:00-1:00'), 'Every day 10:00pm–1:00am');
  assert.equal(read('6:30pm-9:30pm'), 'Every day 6:30pm–9:30pm');
});

test('lecture times: what is not understood is explained, never guessed', () => {
  assert.match(read(''), /Nothing was entered/);
  assert.match(read('Mon Wed'), /No time range found/);
  assert.match(read('2-3:30'), /morning or the afternoon\? Write 2:00pm or 14:00/);
  assert.match(read('Mon 25:00-26:00'), /hour must be 0–23/);
  assert.match(read('8:75-9'), /minutes must be 00–59/);
  assert.match(read('13pm-2pm'), /with am\/pm, the hour must be 1–12/);
  assert.match(read('8-8'), /start and end are the same/);
  assert.match(read('6am-9pm'), /15 hours long/);
  assert.match(read('hello 8-9'), /"hello" is not a day of the week/);
  assert.match(read('S 8-9'), /"s" is not a day of the week/);
  assert.match(read('Sat 8-9 Sun'), /"sun" has no time after it/);
  assert.match(read('Mon 8-9 later'), /"later" is not a day of the week/);
});

test('"any" (and its variants) means no limit', () => {
  for (const t of ['any', 'Any', ' anytime ', 'any time', 'always', 'no limit', 'none']) assert.ok(meansAnyTime(t), t);
  for (const t of ['', 'anything', 'Mon 8-9']) assert.ok(!meansAnyTime(t), t);
});

test('lecture time includes the margin at both ends, and only on the given days', () => {
  const mwf = hours('MWF 8:00-9:30');
  assert.ok(!isLectureTime(mwf, at(5, 7, 54), 5));
  assert.ok(isLectureTime(mwf, at(5, 7, 55), 5));
  assert.ok(isLectureTime(mwf, at(5, 8, 45), 5));
  assert.ok(isLectureTime(mwf, at(5, 9, 34), 5));
  assert.ok(!isLectureTime(mwf, at(5, 9, 35), 5));
  assert.ok(!isLectureTime(mwf, at(5, 10, 49), 5), 'the 10am section of the same course');
  assert.ok(!isLectureTime(mwf, at(6, 8, 45), 5), 'Tuesday');
  assert.ok(isLectureTime(mwf, at(7, 8, 45), 5), 'Wednesday');
  assert.ok(!isLectureTime(mwf, at(5, 7, 58), 0), 'no margin');
});

test('lecture time that runs past midnight belongs to the day it starts', () => {
  const late = hours('Fri 22:00-1:00');
  assert.ok(isLectureTime(late, at(9, 23, 30), 5), 'Friday night');
  assert.ok(isLectureTime(late, at(10, 0, 30), 5), 'early Saturday, still Friday’s lecture');
  assert.ok(!isLectureTime(late, at(10, 1, 6), 5));
  assert.ok(!isLectureTime(late, at(11, 0, 30), 5), 'early Sunday: no Saturday lecture');
});

test('the margin can reach back across midnight', () => {
  const early = hours('Tue 0:02-1:00');
  assert.ok(isLectureTime(early, at(5, 23, 58), 5), 'Monday 23:58 is within 5 minutes of Tuesday 0:02');
});

test('when lecture time next starts', () => {
  const mwf = hours('MWF 8:00-9:30');
  assert.deepEqual(nextLectureStart(mwf, at(5, 7, 0), 5), at(5, 7, 55));
  assert.deepEqual(nextLectureStart(mwf, at(5, 10, 49), 5), at(7, 7, 55));
  assert.deepEqual(nextLectureStart(mwf, at(9, 10, 0), 5), at(12, 7, 55), 'Friday to Monday');
  assert.equal(describeMoment(at(5, 7, 55), at(5, 7, 0)), 'today 7:55am');
  assert.equal(describeMoment(at(6, 14, 0), at(5, 23, 0)), 'tomorrow 2:00pm');
  assert.equal(describeMoment(at(9, 12, 0), at(5, 10, 0)), 'Fri 12:00pm');
});

// ---------------------------------------------------------------- the start-up question

function ask(recent: LectureChoice[], typed: string[], end = false): Promise<{ result: LectureChoice | null; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString();
  });
  const done = askForLectureHours(recent, 5, { input, output }).then((result) => ({ result, shown }));
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

const MWF: LectureChoice = { kind: 'hours', hours: hours('MWF 8:00-9:30') };
const TTH: LectureChoice = { kind: 'hours', hours: hours('TTh 2-3:30pm') };

test('the first time, there is no default: Enter asks again, and typed times are read', async () => {
  const { result, shown } = await ask([], ['', 'MWF 8-9:30']);
  assert.deepEqual(result, MWF);
  assert.match(shown, /When is your lecture\? The bot only answers polls during it \(and 5 minutes either side\)/);
  assert.doesNotMatch(shown, /Saved:/);
  assert.match(shown, /Please type your lecture times/);
});

test('"any" turns the limit off', async () => {
  const { result } = await ask([], ['any']);
  assert.deepEqual(result, { kind: 'any' });
});

test('saved times are listed; Enter picks the newest, a number picks that one', async () => {
  const first = await ask([MWF, TTH], ['']);
  assert.deepEqual(first.result, MWF);
  assert.match(first.shown, /1\) Mon Wed Fri 8:00am–9:30am/);
  assert.match(first.shown, /2\) Tue Thu 2:00pm–3:30pm/);
  assert.match(first.shown, /Press Enter for 1, type a number, or type new times/);
  const second = await ask([MWF, TTH], ['2']);
  assert.deepEqual(second.result, TTH);
});

test('a wrong number or unreadable times are explained, and the question is asked again', async () => {
  const { result, shown } = await ask([MWF], ['3', 'Mon Wed', '2-3:30', 'TTh 2-3:30pm']);
  assert.deepEqual(result, TTH);
  assert.match(shown, /There is no number 3/);
  assert.match(shown, /No time range found/);
  assert.match(shown, /morning or the afternoon/);
});

test('the question gives up quietly when input ends', async () => {
  const { result } = await ask([MWF], [], true);
  assert.equal(result, null);
});

test('recent lecture times are kept newest first, without repeats, up to a limit, alongside the link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-state-'));
  try {
    const file = path.join(dir, 'state.json');
    assert.deepEqual(readRecentHours(file), []);
    writeLastUrl(file, 'https://pollev.com/a');
    rememberHours(file, MWF);
    rememberHours(file, TTH);
    rememberHours(file, MWF);
    assert.deepEqual(readRecentHours(file), [MWF, TTH]);
    assert.equal(readLastUrl(file), 'https://pollev.com/a', 'saving times keeps the link');
    writeLastUrl(file, 'https://pollev.com/b');
    assert.deepEqual(readRecentHours(file), [MWF, TTH], 'saving the link keeps the times');

    for (let i = 0; i < RECENT_HOURS_KEPT + 2; i += 1) rememberHours(file, { kind: 'hours', hours: hours(`Mon ${8 + i}:00-${8 + i}:50`) });
    assert.equal(readRecentHours(file).length, RECENT_HOURS_KEPT);

    // A damaged entry is dropped rather than offered.
    fs.writeFileSync(file, JSON.stringify({ recentHours: [{ kind: 'hours', hours: { slots: [{ days: [9], start: 0, end: 60 }] } }, { kind: 'any' }] }));
    assert.deepEqual(readRecentHours(file), [{ kind: 'any' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
