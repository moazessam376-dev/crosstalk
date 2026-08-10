import { describe, expect, it } from 'vitest';

import type { Claim } from '../../src/contracts/claim.js';
import type { Decision } from '../../src/contracts/decision.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Participant } from '../../src/contracts/participant.js';
import { tally } from '../../src/core/decisions.js';
import type { HubState } from '../../src/core/projection.js';
import { addressesParticipant } from '../../src/daemon/handlers.js';

function participant(id: string, role: 'leader' | 'worker'): Participant {
  return { id, role, harness: 'codex-cli', lifecycle: 'attached', workspace: '.' } as Participant;
}

/** A worker-vs-worker dispute: `membersOf('dispute:C-1')` excludes the leader. */
function disputeState(voters: string[], decision?: Partial<Decision>): HubState {
  const claim: Claim = {
    id: 'C-1',
    raisedBy: 'codex',
    against: 'cursor',
    target: 'src/economy.ts:41',
    assertion: 'staffing coefficient applied twice',
    severity: 'defect',
    falsifier: 'the focused ledger check would print two rows rather than one',
    evidence: [],
    state: 'contested',
    rounds: 4,
  };
  const state: HubState = {
    participants: new Map([
      ['leader', participant('leader', 'leader')],
      ['codex', participant('codex', 'worker')],
      ['cursor', participant('cursor', 'worker')],
    ]),
    tasks: new Map(),
    claims: new Map([['C-1', claim]]),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
  state.decisions.set('D-1', {
    id: 'D-1',
    question: 'settle C-1',
    options: ['raiser', 'responder'],
    voters,
    method: 'ladder',
    ladder: ['discriminating_test', 'third_agent', 'leader'],
    currentRung: 0,
    rationale: [],
    votes: {},
    claimId: 'C-1',
    ...decision,
  });
  return state;
}

const opened = (state: HubState): CrosstalkEvent =>
  ({
    seq: 9,
    ts: '2026-08-10T00:00:00.000Z',
    kind: 'decision_opened',
    from: 'codex',
    room: 'dispute:C-1',
    decision: state.decisions.get('D-1')!,
  }) as CrosstalkEvent;

describe('a decision reaches the people it names', () => {
  it('addresses a leader who is a voter on a worker-vs-worker dispute', () => {
    // C-1: the leader is not in `membersOf('dispute:C-1')` — that adds a leader
    // only for brief/spec claims — yet `leader` is the default terminal rung.
    // Room membership alone leaves the ruler unreachable.
    const state = disputeState(['codex', 'cursor', 'leader', '@human']);
    expect(addressesParticipant(opened(state), 'leader', state)).toBe(true);
  });

  it('does not address a participant who is neither voter nor room member', () => {
    // The neighbouring case. Without it, `return true` would pass the above.
    const state = disputeState(['codex', 'cursor']);
    state.participants.set('stranger', participant('stranger', 'worker') as Participant);
    const strangerState = disputeState(['codex', 'cursor']);
    strangerState.claims.delete('C-1');
    expect(addressesParticipant(opened(strangerState), 'stranger', strangerState)).toBe(false);
  });

  it('still does not address the event of the participant who wrote it', () => {
    const state = disputeState(['codex', 'cursor', 'leader']);
    // A wait that returns on the caller's own writes is a busy loop.
    expect(addressesParticipant(opened(state), 'codex', state)).toBe(false);
  });
});

describe('tally knows who the leader is', () => {
  it('does not resolve a leader-method decision on a worker vote', () => {
    const state = disputeState(['codex', 'leader'], { method: 'leader' });
    const decision = { ...state.decisions.get('D-1')!, votes: { codex: 'raiser' } };
    expect(tally(decision, state)).toBeNull();
  });

  it('resolves a leader-method decision on the leader vote', () => {
    const state = disputeState(['codex', 'leader'], { method: 'leader' });
    const decision = {
      ...state.decisions.get('D-1')!,
      votes: { codex: 'raiser', leader: 'responder' },
    };
    expect(tally(decision, state)).toBe('responder');
  });
});
