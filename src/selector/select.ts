import type { Config } from '../config/config.ts';
import type { PlannedResponse, Poll, SnapshotPoll } from '../types.ts';

/**
 * Decides what to send for a poll. Pure: the same poll, settings and random
 * source always give the same answer. Correctness of the answer is not a goal;
 * the point is to respond.
 */
export function chooseResponse(
  poll: Poll,
  snapshot: SnapshotPoll,
  response: Config['response'],
  rng: () => number = Math.random,
): PlannedResponse {
  if (poll.kind === 'multiple_choice') {
    if (response.multipleChoice === 'skip') return { kind: 'skip', reason: 'multiple-choice strategy is "skip"' };
    const available = poll.options.filter((o) => !o.disabled);
    if (available.length === 0) return { kind: 'skip', reason: 'no option can be selected' };
    let index: number;
    if (response.multipleChoice === 'first') index = 0;
    else if (response.multipleChoice === 'last') index = available.length - 1;
    else index = Math.min(available.length - 1, Math.floor(rng() * available.length));
    const chosen = available[index];
    if (!chosen) return { kind: 'skip', reason: 'no option can be selected' };
    return { kind: 'choice', ref: chosen.ref, label: chosen.label };
  }

  if (poll.kind === 'free_text') {
    if (response.freeText === 'skip') return { kind: 'skip', reason: 'free-text strategy is "skip"' };
    if (!snapshot.textInput || snapshot.textInput.disabled) {
      return { kind: 'skip', reason: 'the text box is not available' };
    }
    // A hidden title leaves nothing to echo; the fixed text is sent instead.
    const question = poll.question.replace(/\s+/g, ' ').trim();
    let value = response.freeText === 'echo_question' && question !== '' ? question : response.fixedText;
    value = value.replace(/\s+/g, ' ').trim();
    const limit = snapshot.textInput.maxLength;
    if (limit !== null && limit > 0 && value.length > limit) value = value.slice(0, limit).trim();
    if (value === '') return { kind: 'skip', reason: 'there is no text to send' };
    return { kind: 'text', value };
  }

  return { kind: 'skip', reason: `unsupported poll type${poll.unsupportedType ? ` (${poll.unsupportedType})` : ''}` };
}
