import { describe, expect, it } from 'vitest';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { ledgerOf, renderLedger } from '../../src/core/ledger.js';

/**
 * What a run cost, from the log it already wrote.
 *
 * There was no accounting at all, so no change to the board could be shown to
 * have worked — the vault run was measured by hand with `jq`, six figures at a
 * time. "The honest test is a re-run" only means anything if those figures are
 * cheap to get, and cheap means derived from the log rather than collected
 * beside it: a counter kept during a run can be wrong, can be lost on restart,
 * and cannot be applied to a run that already happened.
 */

let seq = 0;
function message(over: Partial<CrosstalkEvent> & { from: string }): CrosstalkEvent {
  seq += 1;
  return {
    kind: 'message',
    seq,
    ts: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    room: '#floor',
    body: 'x',
    ...over,
  } as CrosstalkEvent;
}

describe('the run ledger', () => {
  it('counts machine noise posted under the operator', () => {
    // The vault run's largest single finding: 622 of 1187 events were
    // supervisor health notices posted to `#floor` as `@human`. It is a number
    // that should now be zero, which is exactly why it is worth printing.
    const ledger = ledgerOf([
      message({ from: '@human', head: 'peer-2 is taking turns again', body: 'peer-2 is taking turns again' }),
      message({ from: '@human', head: 'peer-2 could not be given the board', body: '…' }),
      message({ from: '@human', head: 'what is the plan?', body: 'what is the plan?' }),
      message({ from: 'peer-1', head: 'taking the parser', body: 'taking the parser' }),
    ]);

    expect(ledger.machineNoise).toBe(2);
    expect(ledger.events).toBe(4);
  });

  it('takes the median body, so one long message does not move it', () => {
    const ledger = ledgerOf([
      message({ from: 'peer-1', head: 'a', body: 'a'.repeat(10) }),
      message({ from: 'peer-1', head: 'b', body: 'b'.repeat(20) }),
      message({ from: 'peer-1', head: 'c', body: 'c'.repeat(3000) }),
    ]);
    const seat = ledger.seats.find((row) => row.seat === 'peer-1')!;
    expect(seat.medianBody).toBe(20);
    expect(seat.longestBody).toBe(3000);
  });

  it('does not count a head-only message as having a body', () => {
    // `body` falls back to `head` on the wire, for every reader that predates
    // the amendment. Counting that as a body would inflate the exact figure
    // this vocabulary exists to bring down.
    const ledger = ledgerOf([message({ from: 'peer-1', head: 'taking the parser', body: 'taking the parser' })]);
    expect(ledger.seats[0]?.medianBody).toBe(0);
    expect(ledger.seats[0]?.medianHead).toBe('taking the parser'.length);
  });

  it('splits the floor from the side rooms', () => {
    // 312 messages opened `peer-N — ` and 0 used a `dm:` room. The split is the
    // measurement that says whether that changed.
    const ledger = ledgerOf([
      message({ from: 'peer-1', room: '#floor', head: 'a' }),
      message({ from: 'peer-1', room: 'dm:peer-1~peer-2', head: 'b' }),
      message({ from: 'peer-1', room: 'dm:peer-1~peer-3', head: 'c' }),
    ]);
    const seat = ledger.seats[0]!;
    expect(seat.onFloor).toBe(1);
    expect(seat.inDirect).toBe(2);
  });

  it('histograms the tags, including what carried none', () => {
    const ledger = ledgerOf([
      message({ from: 'peer-1', tag: 'status', head: 'a' }),
      message({ from: 'peer-1', tag: 'status', head: 'b' }),
      message({ from: 'peer-1', tag: 'result', head: 'c' }),
      message({ from: 'peer-1', head: 'd' }),
    ]);
    expect(ledger.tags).toMatchObject({ status: 2, result: 1, untagged: 1 });
  });

  it('reports the share of traffic in the final third', () => {
    // The vault run accelerated instead of converging: 51% of its messages
    // came in the last three hours of fifteen.
    const events: CrosstalkEvent[] = [];
    for (let index = 0; index < 9; index += 1) {
      events.push({
        kind: 'message',
        seq: index + 1,
        ts: new Date(Date.UTC(2026, 8, 1, index, 0, 0)).toISOString(),
        room: '#floor',
        from: 'peer-1',
        head: 'x',
        body: 'x',
      } as CrosstalkEvent);
    }
    // Hours 0..8; the final third starts at hour 5.33, so three of nine.
    expect(ledgerOf(events).lateShare).toBe(33);
  });

  it('measures how long a seat stayed quiet at the end', () => {
    const ledger = ledgerOf([
      message({ from: 'peer-1', head: 'a', ts: '2026-09-01T00:00:00.000Z' }),
      message({ from: 'peer-2', head: 'b', ts: '2026-09-01T01:00:00.000Z' }),
    ]);
    const first = ledger.seats.find((row) => row.seat === 'peer-1')!;
    expect(first.quietTailSeconds).toBe(3600);
  });

  it('says outright that it cannot see model tokens', () => {
    // A cost report that quietly omits cost is worse than one that says it
    // cannot see it: only the harness knows, and a pty seat never says.
    const rendered = renderLedger(ledgerOf([message({ from: 'peer-1', head: 'a' })]));
    expect(rendered).toContain('Model tokens are not here');
  });

  it('reads an empty log without inventing a run', () => {
    const ledger = ledgerOf([]);
    expect(ledger.events).toBe(0);
    expect(ledger.seats).toEqual([]);
    expect(ledger.lateShare).toBe(0);
    expect(() => renderLedger(ledger)).not.toThrow();
  });
});
