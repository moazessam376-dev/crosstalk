// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { stateForVerdict } from '../../src/core/projection.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { displayState } from '../../src/ui/dispute/DisputeView.js';
import type { Claim, ClaimVerdict } from '../../src/contracts/claim.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

const VERDICTS: ClaimVerdict[] = ['accept', 'contest', 'clarify', 'concede', 'amend', 'uphold'];

const claim = (): Claim => ({
  id: 'C-1',
  raisedBy: 'leader',
  against: 'codex',
  target: 'src/x.ts:1',
  assertion: 'a',
  severity: 'defect',
  falsifier: 'if I am wrong the trace prints one row rather than two',
  evidence: [],
  state: 'open',
  rounds: 0,
});

const response = (verdict: ClaimVerdict): Extract<CrosstalkEvent, { kind: 'claim_response' }> => ({
  seq: 2,
  ts: '2026-08-10T00:00:02Z',
  from: 'codex',
  room: 'dispute:C-1',
  kind: 'claim_response',
  claimId: 'C-1',
  verdict,
  evidence: [],
});

/**
 * The hub derives claim state independently of `src/core/projection.ts`. That
 * boundary is deliberate — it kept Track B unblocked by Track A — but it has
 * now produced two divergences in shipped code:
 *
 *   B-005  the UI said `resolved` where the core said `contested`
 *   F-06   the UI said `triaged` where the core said `resolved`
 *
 * Both were found one verdict at a time, by someone noticing. This asserts the
 * whole union at once, so the third divergence fails a test instead.
 */
describe('the UI and the core agree on what a verdict means', () => {
  it.each(VERDICTS)('%s maps to the same claim state in both', (verdict) => {
    const ui = displayState({
      claim: claim(),
      responses: [response(verdict)],
      staleShas: new Set<string>(),
      extraEvidence: [],
    });

    expect(ui).toBe(stateForVerdict(verdict));
  });

  it('covers every verdict in the union, so adding one fails here first', () => {
    // If ClaimVerdict gains a member and this list is not updated, the
    // exhaustive switch in stateForVerdict throws when it is finally reached —
    // but by then it is a runtime error in the daemon rather than a red test.
    const declared: Record<ClaimVerdict, true> = {
      accept: true,
      contest: true,
      clarify: true,
      concede: true,
      amend: true,
      uphold: true,
    };
    expect(VERDICTS.sort()).toEqual(Object.keys(declared).sort());
  });
});
