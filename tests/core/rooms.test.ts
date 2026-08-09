import { describe, expect, it } from 'vitest';
import { dmId, isMember, membersOf } from '../../src/core/rooms.js';
import type { Claim } from '../../src/contracts/claim.js';
import type { Participant, ParticipantId } from '../../src/contracts/participant.js';
import type { HubState } from '../../src/core/projection.js';

describe('rooms', () => {
  it('sorts dm participants so the id is canonical', () => {
    expect(dmId('codex', 'leader')).toBe('dm:codex~leader');
    expect(dmId('leader', 'codex')).toBe('dm:codex~leader');
  });

  it('puts @human in every room', () => {
    const s = stateWith(['leader', 'cursor', 'codex']);
    for (const room of ['#floor', 'dm:codex~leader', 'task:T-1', 'dispute:C-1']) {
      expect(membersOf(room, s)).toContain('@human');
    }
  });

  it('includes uninvolved workers in a dispute room as observers', () => {
    const s = stateWithDispute('C-1', 'leader', 'codex', ['cursor']);
    expect(membersOf('dispute:C-1', s)).toContain('cursor');
  });

  it('excludes an unrelated worker from a dm', () => {
    const s = stateWith(['leader', 'cursor', 'codex']);
    expect(isMember('cursor', 'dm:codex~leader', s)).toBe(false);
  });
});

function emptyState(): HubState {
  return {
    participants: new Map(),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function stateWith(ids: ParticipantId[]): HubState {
  const state = emptyState();

  for (const id of ids) {
    state.participants.set(id, participant(id));
  }

  return state;
}

function stateWithDispute(
  claimId: string,
  raisedBy: ParticipantId,
  against: ParticipantId,
  uninvolvedWorkers: ParticipantId[],
): HubState {
  const state = stateWith([raisedBy, against, ...uninvolvedWorkers]);
  state.claims.set(claimId, claim(claimId, raisedBy, against));
  return state;
}

function participant(id: ParticipantId): Participant {
  return {
    id,
    role: id === 'leader' ? 'leader' : 'worker',
    harness: '',
    lifecycle: 'attached',
    workspace: '',
  };
}

function claim(id: string, raisedBy: ParticipantId, against: ParticipantId): Claim {
  return {
    id,
    raisedBy,
    against,
    target: 'src/core/rooms.ts:1',
    assertion: 'room membership is wrong',
    severity: 'defect',
    falsifier: 'If wrong, the focused room-membership tests would produce a different member list.',
    evidence: [],
    state: 'open',
    rounds: 0,
  };
}
