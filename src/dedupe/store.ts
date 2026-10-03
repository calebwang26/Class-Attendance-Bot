import fs from 'node:fs';
import path from 'node:path';
import type { PollKind } from '../types.ts';

export interface AnsweredEntry {
  fingerprint: string;
  kind: PollKind;
  /** ISO 8601 time the response was confirmed (or first seen as already answered). */
  at: string;
  /** answered: this tool responded. already_answered: the page already showed a response. */
  outcome: 'answered' | 'already_answered';
  /** The page itself displayed the poll as answered, so its display can be trusted for this poll. */
  pageShowedAnswered: boolean;
  url: string;
  question?: string;
  response?: string;
}

interface StoreFile {
  version: 1;
  entries: AnsweredEntry[];
}

function isEntry(value: unknown): value is AnsweredEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['fingerprint'] === 'string' &&
    typeof e['kind'] === 'string' &&
    typeof e['at'] === 'string' &&
    !Number.isNaN(Date.parse(e['at'] as string)) &&
    (e['outcome'] === 'answered' || e['outcome'] === 'already_answered') &&
    typeof e['pageShowedAnswered'] === 'boolean' &&
    typeof e['url'] === 'string'
  );
}

export interface StoreOpenResult {
  store: AnsweredStore;
  /** Set when an unreadable store file was moved aside and a fresh one started. */
  quarantinedTo: string | null;
  pruned: number;
}

/**
 * Record of polls already answered, kept on disk so a restart mid-session does
 * not answer the same poll again. The file holds fingerprints and timestamps;
 * question text is included only when the caller passes it.
 */
export class AnsweredStore {
  readonly file: string;
  private entries: AnsweredEntry[];
  /** False after a failed write. Entries are still kept in memory. */
  writable = true;

  private constructor(file: string, entries: AnsweredEntry[]) {
    this.file = file;
    this.entries = entries;
  }

  /**
   * Loads the store, creating it if missing. A file that cannot be parsed is
   * renamed to `<name>.corrupt-<timestamp>` and a new store is started. Throws
   * if the location cannot be written at all, so that problem is found before
   * a session starts and not in the middle of one.
   */
  static open(file: string, options: { retainDays: number; now?: Date }): StoreOpenResult {
    const now = options.now ?? new Date();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let entries: AnsweredEntry[] = [];
    let quarantinedTo: string | null = null;
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const list = (parsed as { entries?: unknown } | null)?.entries;
        if (typeof parsed !== 'object' || parsed === null || !Array.isArray(list)) {
          throw new Error('unexpected shape');
        }
        entries = list.filter(isEntry);
      } catch {
        quarantinedTo = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(file, quarantinedTo);
        entries = [];
      }
    }
    const before = entries.length;
    if (options.retainDays > 0) {
      const cutoff = now.getTime() - options.retainDays * 24 * 60 * 60 * 1000;
      entries = entries.filter((e) => Date.parse(e.at) >= cutoff);
    }
    const store = new AnsweredStore(file, entries);
    store.write();
    return { store, quarantinedTo, pruned: before - entries.length };
  }

  /** Newest entry for `fingerprint` at or after `sinceMs` (epoch ms), if any. */
  latest(fingerprint: string, sinceMs: number): AnsweredEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry && entry.fingerprint === fingerprint && Date.parse(entry.at) >= sinceMs) return entry;
    }
    return undefined;
  }

  /** Adds an entry. Returns false if it could not be written to disk (it is kept in memory). */
  record(entry: AnsweredEntry): boolean {
    this.entries.push(entry);
    return this.save();
  }

  /** Notes that the page displayed the newest entry for `fingerprint` as answered. */
  markPageShowedAnswered(fingerprint: string): boolean {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry && entry.fingerprint === fingerprint) {
        if (entry.pageShowedAnswered) return true;
        entry.pageShowedAnswered = true;
        return this.save();
      }
    }
    return true;
  }

  get size(): number {
    return this.entries.length;
  }

  private save(): boolean {
    try {
      this.write();
      this.writable = true;
    } catch {
      this.writable = false;
    }
    return this.writable;
  }

  /** Writes atomically: a crash mid-write leaves the previous file intact. */
  private write(): void {
    const data: StoreFile = { version: 1, entries: this.entries };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
    fs.renameSync(tmp, this.file);
  }
}
