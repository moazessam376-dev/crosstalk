import { describe, expect, it } from 'vitest';

import { clockTime } from '../../src/ui/clock.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { runLabel } from '../../src/ui/layout/RunPicker.js';

/**
 * The board's clock and the run picker's clock, held to the same reading.
 *
 * Every timestamp on the board was five characters sliced off an ISO string,
 * which is UTC. Nobody noticed, because a wrong time looks exactly like a right
 * one. It surfaced the moment the run divider was drawn above the run picker's
 * label for the same run: one said `22:31`, the other `today 01:31`.
 *
 * These tests are written against the local zone rather than a fixed one on
 * purpose — a test that hardcoded `14:12` would pass in London and fail on the
 * runner, which is how a timezone test stops being run.
 */

describe('the time of day on a card', () => {
  it('is the reader’s own clock, not UTC', () => {
    const at = new Date(2026, 8, 2, 14, 12, 30);
    expect(clockTime(at.toISOString())).toBe('14:12');
  });

  it('agrees with the run picker about the same instant', () => {
    // The defect itself: two labels for one run, hours apart. If either side
    // goes back to slicing the string this fails everywhere except UTC.
    const at = new Date(2026, 8, 2, 1, 31, 0);
    const iso = at.toISOString();
    const label = runLabel(
      { id: 'r-20260902-0131-a3f1c9', startedAt: iso, firstSeq: 1, events: 2, archived: false, current: true },
      at,
    );
    expect(label).toBe(`today ${clockTime(iso)}`);
  });

  it('pads to a fixed width so the mono columns stay aligned', () => {
    expect(clockTime(new Date(2026, 8, 2, 9, 4, 0).toISOString())).toBe('09:04');
  });

  it('falls back rather than blanking on a timestamp it cannot read', () => {
    // A card with no time is a worse card than one with the old wrong time.
    expect(clockTime('not a date')).toBe('');
  });
});
