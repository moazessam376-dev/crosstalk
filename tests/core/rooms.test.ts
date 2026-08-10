import { describe, expect, it } from 'vitest';
import { dmId, isMember, membersOf } from '../../src/core/rooms.js';
import type { Claim } from '../../src/contracts/claim.js';
import type { Participant, ParticipantId } from '../../src/contracts/participant.js';
import type { Task } from '../../src/contracts/task.js';
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

  it('keeps the claimant and uninvolved workers in a brief dispute room', () => {
    const s = stateWithNonParticipantDispute('C-2', 'leader', 'brief', ['cursor', 'codex']);
    expect(membersOf('dispute:C-2', s)).toEqual(['leader', 'cursor', 'codex', '@human']);
  });

  it('includes the brief owner when a worker raises a brief dispute', () => {
    const s = stateWithNonParticipantDispute('C-3', 'codex', 'brief', ['cursor']);
    expect(membersOf('dispute:C-3', s)).toEqual(['codex', 'leader', 'cursor', '@human']);
  });

  it('includes all leaders plus the assignee in a task room', () => {
    const s = stateWithTaskRoom('T-1', ['leader', 'review-leader'], 'codex');
    expect(membersOf('task:T-1', s)).toEqual(['leader', 'review-leader', 'codex', '@human']);
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
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function stateWith(ids: ParticipantId[]): HubState {
  const state = emptyState();

  for (const id of ids) {
    state.participants.set(id, participant(id, id === 'leader' ? 'leader' : 'worker'));
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

function stateWithNonParticipantDispute(
  claimId: string,
  raisedBy: ParticipantId,
  against: 'brief' | 'spec',
  uninvolvedWorkers: ParticipantId[],
): HubState {
  const state = stateWith(['leader', raisedBy, ...uninvolvedWorkers]);
  state.claims.set(claimId, claim(claimId, raisedBy, against));
  return state;
}

function stateWithTaskRoom(taskId: string, leaders: ParticipantId[], assignee: ParticipantId): HubState {
  const state = emptyState();

  for (const leader of leaders) {
    state.participants.set(leader, participant(leader, 'leader'));
  }

  state.participants.set(assignee, participant(assignee, 'worker'));
  state.tasks.set(taskId, task(taskId, assignee));

  return state;
}

function participant(id: ParticipantId, role: Participant['role']): Participant {
  return {
    id,
    role,
    harness: '',
    lifecycle: 'attached',
    workspace: '',
  };
}

function task(id: string, assignee: ParticipantId): Task {
  return {
    id,
    title: 'Review room membership',
    brief: 'Ensure task rooms include their expected members.',
    specRefs: ['§4.2'],
    assignee,
    deps: [],
    acceptance: ['task room includes leaders and assignee'],
    state: 'assigned',
    branch: 'track-a/core',
  };
}

function claim(id: string, raisedBy: ParticipantId, against: ParticipantId | 'brief' | 'spec'): Claim {
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