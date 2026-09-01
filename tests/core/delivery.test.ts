import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { SAY_LIMIT, refuseOversizeBody } from '../../src/contracts/events.js';
import { project } from '../../src/core/projection.js';
import { DELIVERY_BUDGET, cardFor, renderInbox } from '../../src/core/inbox.js';

/**
 * The beacon-1 defect, as a test.
 *
 * A card was `clip(body, 120)` and had no body field, so a seat could not read
 * what a teammate had said through the protocol at all. The measured result was
 * that 5% of the strongest seat's output reached its teammates; the two
 * findings that would have prevented a 21-minute duplicated build were both cut
 * mid-sentence.
 *
 * These assert on what a seat *learns*, not on what `clip()` returns. A test
 * that pins the clip length passes just as happily when the finding is lost.
 */

function said(seq: number, from: string, body: string, ref?: string): CrosstalkEvent {
  return {
    kind: 'message',
    ts: '2026-08-31T00:00:00.000Z',
    from,
    room: '#floor',
    seq,
    body,
    ...(ref === undefined ? {} : { ref }),
  };
}

/** The shape of the message that went missing on beacon-1, at its real length. */
const FINDING = [
  'merged: ct/opus @ e043252 — integration is GREEN: typecheck clean, 13/13 tests pass.',
  '',
  'Now two real defects in the merged sim. Both are in fleet.ts.',
  '',
  '1 (blocker): the run is unwinnable after a single wreck. nightFleet() is exactly',
  'eight ships and DOCK_GOAL is 8, so one wreck makes eight dockings unreachable and',
  'the outcome never leaves playing.',
].join('\n');

describe('a seat learns what a teammate said', () => {
  it('carries the whole message, not a scannable fragment of it', () => {
    const card = cardFor(said(27, 'opus', FINDING));

    expect(card.body).toBe(FINDING);
    expect(card.truncated).toBeUndefined();
    // The part that beacon-1 dropped, and the reason the build was duplicated.
    expect(card.body).toContain('unwinnable after a single wreck');
  });

  it('still offers one scannable line for choosing what to read', () => {
    const card = cardFor(said(27, 'opus', FINDING));

    expect(card.summary.length).toBeLessThanOrEqual(120);
    expect(card.summary.startsWith('merged: ct/opus @ e043252')).toBe(true);
    expect(card.summary).not.toBe(card.body);
  });

  it('reaches the teammate through renderInbox, whole', () => {
    const inbox = renderInbox({
      who: 'sonnet',
      role: 'peer',
      unread: [said(27, 'opus', FINDING)],
      state: project([]),
    });

    const card = inbox.unread.find((c) => c.from === 'opus');
    expect(card?.body).toContain('unwinnable after a single wreck');
  });

  it('carries the artifact the author pointed at', () => {
    const card = cardFor(said(28, 'opus', 'harbour is wired and playable', 'ct/opus@bf66cd0'));
    expect(card.ref).toBe('ct/opus@bf66cd0');
  });

  it('admits a cut rather than letting a fragment read as whole', () => {
    const huge = 'x'.repeat(DELIVERY_BUDGET + 500);
    const card = cardFor(said(29, '@human', huge));

    expect(card.truncated).toBe(true);
    expect(card.body?.endsWith('…')).toBe(true);
    expect(card.body!.length).toBeLessThanOrEqual(DELIVERY_BUDGET + 1);
  });

  it('carries a claim assertion whole — the assertion is the claim', () => {
    const assertion =
      'TEAM_DONE.md names ct/sonnet@77b3d6d as the score branch, but 77b3d6d does not contain ' +
      'the two commits that fixed the rendering. Scoring it scores a build whose page shows a ' +
      'blown-out white cloud over half the bay and hard black bars top and bottom.';
    const card = cardFor({
      kind: 'claim_raised',
      seq: 85,
      ts: '2026-08-31T00:00:00.000Z',
      from: 'opus',
      room: 'dispute:C-1',
      claim: {
        id: 'C-1',
        raisedBy: 'opus',
        against: 'sonnet',
        target: 'TEAM_DONE.md',
        assertion,
        severity: 'blocker',
        falsifier: 'git merge-base --is-ancestor f063c41 ct/sonnet',
        evidence: [],
        state: 'open',
        rounds: 0,
      },
    });

    expect(card.body).toBe(assertion);
    expect(card.summary.length).toBeLessThanOrEqual(120);
  });
});

describe('the cap that keeps a message deliverable', () => {
  it('lets an ordinary finding through untouched', () => {
    expect(refuseOversizeBody(FINDING, 'opus')).toBeNull();
    expect(FINDING.length).toBeLessThan(SAY_LIMIT);
  });

  it('refuses an over-cap body and says what to do instead', () => {
    const refusal = refuseOversizeBody('x'.repeat(SAY_LIMIT + 1), 'opus');

    expect(refusal).not.toBeNull();
    expect(refusal).toContain(String(SAY_LIMIT));
    // The refusal has to name the way out, or the agent just truncates by hand.
    expect(refusal).toContain('ref');
  });

  it('exempts the operator, whose job brief is not chat', () => {
    expect(refuseOversizeBody('x'.repeat(SAY_LIMIT * 2), '@human')).toBeNull();
  });

  it('keeps the cap inside the delivery budget, so a posted message always arrives whole', () => {
    expect(SAY_LIMIT).toBeLessThanOrEqual(DELIVERY_BUDGET);
  });
});
