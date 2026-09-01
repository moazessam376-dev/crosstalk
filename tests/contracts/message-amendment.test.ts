import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { MESSAGE_TAGS, isMessageTag } from '../../src/contracts/say.js';

/**
 * Named thaw, beside `spoc`: a `message` may carry `tag`, `head` and `task`.
 * No new event kinds.
 *
 * `MessageCard` has been asking for `head` since it was written — a clip at 320
 * characters is a guess at what mattered and the author knows — and its own
 * comment says the change "wants a claim rather than a unilateral edit". This
 * is that claim. It arrives now because `head` is also the lever on length: a
 * mandatory one-liner with an optional body makes the short form the default
 * shape of a message, which no smaller cap could.
 *
 * Every field is optional, because the log is append-only and the 1187 events
 * already written have none of them.
 */
describe('message contract amendment', () => {
  it('accepts a tagged message with a head', () => {
    const event: CrosstalkEvent = {
      kind: 'message',
      seq: 1,
      ts: '2026-09-01T00:00:00.000Z',
      from: 'peer-1',
      room: '#floor',
      body: 'wind sim lands, 14 tests green',
      head: 'wind sim lands, 14 tests green',
      tag: 'result',
      ref: 'src/wind.ts',
      task: 'S-3',
    };

    expect(event.kind === 'message' && event.tag).toBe('result');
    expect(event.kind === 'message' && event.task).toBe('S-3');
  });

  it('still types a message written before the amendment', () => {
    // The whole log to date. If this stops compiling, replay is broken.
    const old: CrosstalkEvent = {
      kind: 'message',
      seq: 1,
      ts: '2026-08-31T21:54:18.964Z',
      from: '@human',
      room: '#floor',
      body: 'Read JOB.md at the root of your worktree.',
    };

    expect(old.kind === 'message' && old.tag).toBeUndefined();
    expect(old.kind === 'message' && old.head).toBeUndefined();
  });

  it('guards the tag vocabulary at runtime, not only at the type level', () => {
    for (const tag of MESSAGE_TAGS) expect(isMessageTag(tag)).toBe(true);
    for (const nonsense of ['claim', 'Status', '', null, 7]) expect(isMessageTag(nonsense)).toBe(false);
  });
});
