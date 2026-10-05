import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { normalizeUrl } from '../config/config.ts';
import { describeLectureHours, isLectureHours, meansAnyTime, parseLectureHours, type LectureHours } from '../schedule/lectureHours.ts';

/** When the bot may answer: only in lecture time, or at any time. */
export type LectureChoice = { kind: 'any' } | { kind: 'hours'; hours: LectureHours };

/** How many recent lecture times are kept to choose from. */
export const RECENT_HOURS_KEPT = 5;

interface StateFile {
  lastUrl?: string;
  /** Lecture times entered recently, newest first. */
  recentHours?: unknown[];
}

type Io = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
const TERMINAL: Io = { input: process.stdin, output: process.stdout };

function readState(stateFile: string): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

/** Updates some keys of the state file, keeping the others. */
function updateState(stateFile: string, change: Partial<StateFile>): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const data: StateFile = { ...readState(stateFile), ...change };
    fs.writeFileSync(stateFile, `${JSON.stringify(data, null, 1)}\n`);
  } catch {
    // Only a convenience; not worth stopping for.
  }
}

/** Remembers the last link used, so it can be offered as the default next time. */
export function readLastUrl(stateFile: string): string | null {
  const { lastUrl } = readState(stateFile);
  return typeof lastUrl === 'string' && lastUrl !== '' ? lastUrl : null;
}

export function writeLastUrl(stateFile: string, url: string): void {
  updateState(stateFile, { lastUrl: url });
}

function isChoice(value: unknown): value is LectureChoice {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; hours?: unknown };
  return v.kind === 'any' || (v.kind === 'hours' && isLectureHours(v.hours));
}

/** Lecture times entered recently, newest first. Anything unreadable is dropped. */
export function readRecentHours(stateFile: string): LectureChoice[] {
  const { recentHours } = readState(stateFile);
  if (!Array.isArray(recentHours)) return [];
  return recentHours.filter(isChoice).slice(0, RECENT_HOURS_KEPT);
}

/** Puts `choice` first in the recent list (moving it there if it is already listed). */
export function rememberHours(stateFile: string, choice: LectureChoice): void {
  const key = describeChoice(choice);
  const rest = readRecentHours(stateFile).filter((c) => describeChoice(c) !== key);
  updateState(stateFile, { recentHours: [choice, ...rest].slice(0, RECENT_HOURS_KEPT) });
}

export function describeChoice(choice: LectureChoice): string {
  return choice.kind === 'any' ? 'any time (no limit)' : describeLectureHours(choice.hours);
}

/** Reads typed lecture times, or "any". */
export function parseChoice(text: string): { ok: true; choice: LectureChoice } | { ok: false; error: string } {
  if (meansAnyTime(text)) return { ok: true, choice: { kind: 'any' } };
  const parsed = parseLectureHours(text);
  return parsed.ok ? { ok: true, choice: { kind: 'hours', hours: parsed.hours } } : parsed;
}

/**
 * Runs `ask` with a readline interface whose questions also settle when input
 * ends (Ctrl+D, or a closed pipe); otherwise a pending question never would.
 */
async function withQuestions<T>(io: Io, ask: (question: (prompt: string) => Promise<string | null>) => Promise<T>): Promise<T> {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  const closed = new Promise<null>((resolve) => {
    rl.once('close', () => resolve(null));
  });
  try {
    return await ask((prompt) => Promise.race([rl.question(prompt).catch(() => null), closed]));
  } finally {
    rl.close();
  }
}

/**
 * Asks for the poll link at the terminal until a usable one is given.
 * Pressing Enter with nothing typed reuses `lastUrl` when there is one.
 * Returns null if input ends (Ctrl+D) or the terminal is not interactive.
 */
export async function askForUrl(lastUrl: string | null, io: Io = TERMINAL): Promise<string | null> {
  return withQuestions(io, async (question) => {
    for (;;) {
      const hint = lastUrl ? ` (press Enter to reuse ${lastUrl})` : '';
      const answer = await question(`Paste the poll link${hint}: `);
      if (answer === null) return null;
      const text = answer.trim();
      if (text === '') {
        if (lastUrl) return lastUrl;
        io.output.write('Please paste a link, for example pollev.com/yourpresenter\n');
        continue;
      }
      try {
        return normalizeUrl(text);
      } catch (error) {
        io.output.write(`That does not look right: ${(error as Error).message}. Try again.\n`);
      }
    }
  });
}

/**
 * Asks when the person's lecture is, until it gets an answer it understands.
 * There is no silent default: Enter picks the most recent saved times only
 * when there are some, and "any" must be typed to answer at any time.
 * Returns null if input ends.
 */
export async function askForLectureHours(recent: readonly LectureChoice[], marginMinutes: number, io: Io = TERMINAL): Promise<LectureChoice | null> {
  return withQuestions(io, async (question) => {
    const margin = marginMinutes > 0 ? ` (and ${marginMinutes} minutes either side)` : '';
    io.output.write(`\nWhen is your lecture? The bot only answers polls during it${margin}.\n`);
    io.output.write('  For example:  Mon Wed Fri 8:00-9:30   or   TTh 2-3:30pm   or   any  (no limit)\n');
    if (recent.length > 0) {
      io.output.write('  Saved:\n');
      recent.forEach((choice, i) => io.output.write(`    ${i + 1}) ${describeChoice(choice)}\n`));
      io.output.write(recent.length > 1 ? `  Press Enter for 1, type a number, or type new times.\n` : '  Press Enter to use it, or type new times.\n');
    }
    for (;;) {
      const answer = await question('Lecture times: ');
      if (answer === null) return null;
      const text = answer.trim();
      if (text === '') {
        const first = recent[0];
        if (first) return first;
        io.output.write('Please type your lecture times, for example Mon Wed Fri 8:00-9:30, or "any" for no limit.\n');
        continue;
      }
      if (/^\d+$/.test(text) && recent.length > 0) {
        const picked = recent[Number(text) - 1];
        if (picked) return picked;
        io.output.write(`There is no number ${text}. Type 1${recent.length > 1 ? `–${recent.length}` : ''}, or new times.\n`);
        continue;
      }
      const parsed = parseChoice(text);
      if (parsed.ok) return parsed.choice;
      io.output.write(`${parsed.error}. Try again.\n`);
    }
  });
}
