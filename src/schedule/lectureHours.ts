/**
 * Lecture times: when the bot may answer polls. A course's lectures can share
 * one poll link with another section's, so outside the person's own lecture
 * times the bot watches but never answers.
 *
 * Times are the computer's local time. Written forms accepted, for example:
 *   Mon Wed Fri 8:00-9:30
 *   MWF 8-9:30am
 *   Tue/Thu 2:00pm-3:30pm
 *   Mon 8:00-9:30, Thu 14:00-15:20
 *   weekdays 10:10-11
 *   8:00-9:30                    (every day)
 */

/** One block of lecture time. Minutes after midnight; `end` before `start` runs past midnight. */
export interface LectureSlot {
  /** Days of the week (0 = Sunday … 6 = Saturday), or null for every day. */
  days: number[] | null;
  start: number;
  end: number;
}

export interface LectureHours {
  slots: LectureSlot[];
}

export type ParseResult = { ok: true; hours: LectureHours } | { ok: false; error: string };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Display order: the school week first. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DAY_WORDS: Record<string, number> = {
  su: 0, sun: 0, sunday: 0, sundays: 0,
  m: 1, mo: 1, mon: 1, monday: 1, mondays: 1,
  t: 2, tu: 2, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  w: 3, we: 3, wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  r: 4, th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  f: 5, fr: 5, fri: 5, friday: 5, fridays: 5,
  sa: 6, sat: 6, saturday: 6, saturdays: 6,
};
const GROUP_WORDS: Record<string, number[] | null> = {
  weekdays: [1, 2, 3, 4, 5],
  weekday: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  weekend: [0, 6],
  daily: null,
  everyday: null,
};
/** Words that may sit between days and times without meaning anything. */
const FILLER = new Set(['on', 'and', 'at', 'from', 'every', 'each']);
/** Letters run together, as on a timetable: MWF, TTh, TuTh, MTWRF. */
const COMPACT = /^(su|sa|th|tu|m|t|w|r|f)+$/;
const COMPACT_PART = /su|sa|th|tu|m|t|w|r|f/g;

/** A time range: 8-9:30, 8:00am - 9:30am, 14:00 to 15:20, 8.00–9.30. */
const RANGE =
  /(?<![\d:.])(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?\s*(?:-|–|—|\bto\b|\buntil\b|\btill\b)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?(?![\w:])/g;

/** Whether the text says there should be no limit. */
export function meansAnyTime(text: string): boolean {
  return /^\s*(any|anytime|any time|always|no limit|none)\s*$/i.test(text);
}

interface Clock {
  hour: number;
  minute: number;
  suffix: 'am' | 'pm' | null;
  /** Written with a leading zero (07:00), which reads as the 24-hour clock. */
  padded: boolean;
}

function suffixOf(raw: string | undefined): 'am' | 'pm' | null {
  if (!raw) return null;
  return raw.startsWith('a') ? 'am' : 'pm';
}

function to24(clock: Clock, suffix: 'am' | 'pm'): number {
  const h = clock.hour % 12;
  return (suffix === 'pm' ? h + 12 : h) * 60 + clock.minute;
}

/** 8:00am, 2:30pm, 12:00pm (noon), 12:00am (midnight). */
export function show(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

/** Works out a time range in minutes after midnight, or explains why it cannot. */
function resolveRange(text: string, a: Clock, b: Clock): { start: number; end: number } | { error: string } {
  for (const c of [a, b]) {
    if (c.minute > 59) return { error: `"${text}": minutes must be 00–59` };
    if (c.suffix && (c.hour < 1 || c.hour > 12)) return { error: `"${text}": with am/pm, the hour must be 1–12` };
    if (!c.suffix && c.hour > 23) return { error: `"${text}": the hour must be 0–23` };
  }
  let start: number;
  let end: number;
  if (a.suffix && b.suffix) {
    start = to24(a, a.suffix);
    end = to24(b, b.suffix);
  } else if (a.suffix || b.suffix) {
    // One side says am/pm: the other side shares it, unless that would put the end before the start.
    const given = (a.suffix ?? b.suffix) as 'am' | 'pm';
    const other: 'am' | 'pm' = given === 'am' ? 'pm' : 'am';
    if (a.suffix) {
      start = to24(a, given);
      if (b.hour > 12) end = b.hour * 60 + b.minute;
      else {
        end = to24(b, given);
        if (end <= start) end = to24(b, other);
      }
    } else {
      end = to24(b, given);
      if (a.hour > 12) start = a.hour * 60 + a.minute;
      else {
        start = to24(a, given);
        if (start >= end) start = to24(a, other);
      }
    }
  } else {
    // No am/pm. 0:00–0:59 and 8:00–23:59 are taken as written (8–11 as morning,
    // 12 as noon). 1:00–7:59 could be morning or afternoon, so it is not guessed.
    if (a.hour >= 1 && a.hour <= 7 && !a.padded) {
      return { error: `"${text}": is ${a.hour}:${String(a.minute).padStart(2, '0')} in the morning or the afternoon? Write ${a.hour}:${String(a.minute).padStart(2, '0')}pm or ${a.hour + 12}:${String(a.minute).padStart(2, '0')}` };
    }
    start = a.hour * 60 + a.minute;
    end = b.hour * 60 + b.minute;
    if (end === start) return { error: `"${text}": the start and end are the same` };
    // "11-1:15" or "10-12:15": an end that would come before the start, on a 12-hour
    // clock face, is the afternoon. Only for a short (up to 12-hour) span.
    if (end <= start && b.hour >= 1 && b.hour <= 12 && !b.padded && end + 720 > start) end += 720;
  }
  if (end === start) return { error: `"${text}": the start and end are the same` };
  const length = (end - start + 1440) % 1440;
  if (length > 12 * 60) {
    return { error: `"${text}" is ${Math.floor(length / 60)} hours long (${show(start)} to ${show(end)}). Check the times; for no limit, type "any".` };
  }
  return { start, end: end % 1440 };
}

/** Day words between time ranges: "Mon Wed Fri", "MWF", "Tue/Thu", "Mon-Fri", "weekdays". */
function parseDays(text: string): { days: Set<number> | null; any: boolean } | { error: string } {
  const days = new Set<number>();
  let everyDay = false;
  const words = text
    .toLowerCase()
    .replace(/\bevery\s+day\b/g, 'everyday')
    .split(/[\s,;/&+]+|\band\b/)
    .filter((w) => w !== '' && !FILLER.has(w));
  for (const raw of words) {
    const word = raw.replace(/\.$/, '');
    const range = /^([a-z]+)-([a-z]+)$/.exec(word);
    if (range) {
      const from = DAY_WORDS[range[1] ?? ''];
      const to = DAY_WORDS[range[2] ?? ''];
      if (from === undefined || to === undefined) return { error: `"${raw}" is not a range of days` };
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    if (word in GROUP_WORDS) {
      const group = GROUP_WORDS[word];
      if (group === null || group === undefined) everyDay = true;
      else group.forEach((d) => days.add(d));
      continue;
    }
    const day = DAY_WORDS[word];
    if (day !== undefined) {
      days.add(day);
      continue;
    }
    if (COMPACT.test(word)) {
      for (const part of word.match(COMPACT_PART) ?? []) days.add(DAY_WORDS[part] as number);
      continue;
    }
    return { error: `"${raw}" is not a day of the week` };
  }
  if (everyDay) return { days: null, any: true };
  return { days: days.size > 0 ? days : null, any: days.size > 0 };
}

/**
 * Reads lecture times as a person would type them. Every part must be
 * understood: anything left over is an error, never ignored.
 */
export function parseLectureHours(input: string): ParseResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Nothing was entered' };
  const lower = text.toLowerCase();
  const slots: LectureSlot[] = [];
  let pendingDays: Set<number> | null = null;
  let pendingAny = false;
  let lastDays: number[] | null | undefined;
  let cursor = 0;
  RANGE.lastIndex = 0;
  for (let match = RANGE.exec(lower); match !== null; match = RANGE.exec(lower)) {
    const before = lower.slice(cursor, match.index);
    const parsed = parseDays(before);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    if (parsed.any) {
      pendingDays = parsed.days;
      pendingAny = true;
    }
    const raw = text.slice(match.index, match.index + match[0].length).trim();
    const range = resolveRange(raw, clockOf(match[1], match[2], match[3]), clockOf(match[4], match[5], match[6]));
    if ('error' in range) return { ok: false, error: range.error };
    // A range with no days of its own repeats the days before it ("Mon 8-9, 13:00-14:00").
    const days: number[] | null = pendingAny ? (pendingDays ? sortDays([...pendingDays]) : null) : (lastDays ?? null);
    slots.push({ days, start: range.start, end: range.end });
    lastDays = days;
    pendingDays = null;
    pendingAny = false;
    cursor = match.index + match[0].length;
  }
  const rest = lower.slice(cursor);
  if (slots.length === 0) {
    return { ok: false, error: 'No time range found. Write it like 8:00-9:30' };
  }
  const trailing = parseDays(rest);
  if ('error' in trailing) return { ok: false, error: trailing.error };
  if (trailing.any) return { ok: false, error: `"${rest.trim()}" has no time after it. Put the days before their times, like Mon Wed 8:00-9:30` };
  return { ok: true, hours: { slots } };
}

function clockOf(hour: string | undefined, minute: string | undefined, suffix: string | undefined): Clock {
  return {
    hour: Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    suffix: suffixOf(suffix),
    padded: (hour ?? '').length === 2 && (hour ?? '').startsWith('0'),
  };
}

function sortDays(days: number[]): number[] {
  return [...new Set(days)].sort((x, y) => DAY_ORDER.indexOf(x) - DAY_ORDER.indexOf(y));
}

function describeDays(days: number[] | null): string {
  if (days === null) return 'Every day';
  const key = sortDays(days).join(',');
  if (key === '1,2,3,4,5') return 'Mon–Fri';
  if (key === '1,2,3,4,5,6,0') return 'Every day';
  return sortDays(days).map((d) => DAY_NAMES[d]).join(' ');
}

/** For people: "Mon Wed Fri 8:00am–9:30am, Thu 2:00pm–3:20pm". */
export function describeLectureHours(hours: LectureHours): string {
  return hours.slots.map((s) => `${describeDays(s.days)} ${show(s.start)}–${show(s.end)}`).join(', ');
}

/** Every [start, end) window, with the margin, that could contain `at`, plus the next few days'. */
function windows(hours: LectureHours, at: Date, marginMinutes: number, fromDay: number, toDay: number): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  for (let offset = fromDay; offset <= toDay; offset += 1) {
    const y = at.getFullYear();
    const mo = at.getMonth();
    const d = at.getDate() + offset;
    const weekday = new Date(y, mo, d).getDay();
    for (const slot of hours.slots) {
      if (slot.days !== null && !slot.days.includes(weekday)) continue;
      const endMinutes = slot.end > slot.start ? slot.end : slot.end + 1440;
      // The Date constructor carries overflowing minutes into the next hour or day, and
      // follows daylight-saving changes in local time.
      out.push({
        start: new Date(y, mo, d, 0, slot.start - marginMinutes),
        end: new Date(y, mo, d, 0, endMinutes + marginMinutes),
      });
    }
  }
  return out;
}

/** Whether `at` falls within lecture time, `marginMinutes` either side included. */
export function isLectureTime(hours: LectureHours, at: Date, marginMinutes: number): boolean {
  const t = at.getTime();
  return windows(hours, at, marginMinutes, -1, 1).some((w) => t >= w.start.getTime() && t < w.end.getTime());
}

/** When lecture time (with the margin) next begins after `at`, or null if never. */
export function nextLectureStart(hours: LectureHours, at: Date, marginMinutes: number): Date | null {
  const t = at.getTime();
  let best: Date | null = null;
  for (const w of windows(hours, at, marginMinutes, 0, 8)) {
    if (w.start.getTime() > t && (best === null || w.start < best)) best = w.start;
  }
  return best;
}

/** "Wed 7:55am" (or "today 7:55am" / "tomorrow 7:55am"), for messages. */
export function describeMoment(when: Date, now: Date): string {
  const time = show(when.getHours() * 60 + when.getMinutes());
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(when) - dayStart(now)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${DAY_NAMES[when.getDay()]} ${time}`;
}

/** Checks a stored value is a well-formed LectureHours. */
export function isLectureHours(value: unknown): value is LectureHours {
  if (typeof value !== 'object' || value === null) return false;
  const slots = (value as { slots?: unknown }).slots;
  if (!Array.isArray(slots) || slots.length === 0) return false;
  return slots.every((s: unknown) => {
    if (typeof s !== 'object' || s === null) return false;
    const { days, start, end } = s as Record<string, unknown>;
    const minute = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 1440;
    const daysOk = days === null || (Array.isArray(days) && days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6));
    return daysOk && minute(start) && minute(end) && start !== end;
  });
}
