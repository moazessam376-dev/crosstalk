/**
 * What a board message is for.
 *
 * The vocabulary lives here rather than in `core/` because it is on the wire:
 * a `message` event carries its tag, and every reader of the log has to know
 * the set. The budgets and the refusals that go with each tag are policy and
 * live in `core/says.ts`.
 *
 * Drawn from what the runs actually contained rather than from a taxonomy. The
 * vault-team log is 560 peer messages and every one is one of these eight
 * things.
 *
 * `claim` is deliberately absent. Court already owns contradiction, and a
 * second door into the same room is how a protocol grows two spellings for one
 * act.
 */
export type MessageTag = 'status' | 'result' | 'ask' | 'answer' | 'blocked' | 'gate' | 'plan' | 'note';

export const MESSAGE_TAGS: readonly MessageTag[] = [
  'status',
  'result',
  'ask',
  'answer',
  'blocked',
  'gate',
  'plan',
  'note',
];

export function isMessageTag(value: unknown): value is MessageTag {
  return typeof value === 'string' && (MESSAGE_TAGS as readonly string[]).includes(value);
}

/**
 * A head is one line, and it is the message.
 *
 * The vault-team run wrote a median of 1429 characters against a 1500-character
 * cap — 95% of the allowance, on every message, from every seat. That is not
 * verbosity, it is budget-filling, and lowering the cap moves the median rather
 * than the habit. What changes the habit is making the short form the only
 * required one: `head` is mandatory and `body` is not.
 */
export const HEAD_LIMIT = 120;
