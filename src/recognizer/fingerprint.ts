import crypto from 'node:crypto';
import type { PollKind } from '../types.ts';

/** Canonical form for comparing text: Unicode-normalised, whitespace collapsed, case-folded. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable identity for a poll.
 *
 * When the page exposes the site's own id for the poll, that id (with the
 * kind of poll) is the identity: it stays the same while the text is drawn,
 * edited or hidden, and two different polls with identical wording differ.
 *
 * Otherwise the identity is derived from what the poll asks: the same
 * question with the same options (in any order) gives the same value; a
 * change to the question, an option, or the kind gives a different one.
 */
export function fingerprintOf(poll: {
  kind: PollKind;
  question: string;
  options: readonly string[];
  siteId?: string | null;
}): string {
  const payload =
    poll.siteId !== undefined && poll.siteId !== null && poll.siteId !== ''
      ? JSON.stringify(['id', poll.kind, poll.siteId])
      : JSON.stringify(['text', poll.kind, normalizeText(poll.question), poll.options.map(normalizeText).sort()]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}
