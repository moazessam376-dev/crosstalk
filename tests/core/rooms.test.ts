import { describe, expect, it } from 'vitest';
import { dmId, isMember, membersOf, normaliseRoom } from '../../src/core/rooms.js';
import type { Claim } from '../../src/contracts/claim.js';
import type { Participant, ParticipantId } from '../../src/contracts/participant.js';
import type { Task } from '../../src/contracts/task.js';
import type { HubState } from '../../src/core/projection.js';

/**
 * `dmId` sorts its two participants, but nothing normalised a room id arriving
 * from outside — a CLI argument, an MCP call, a hand-written request. So
 * `dm:leader~codex` and `dm:codex~leader` addressed two distinct rooms with
 * identical membership, each with its own entry in the sidebar and neither
 * showing the other's messages.
 */
describe('a side room has one id, whoever spells it', () => {
  it('sorts the participants of a dm id', () => {
    expect(normaliseRoom('dm:leader~codex')).toBe('dm:codex~leader');
    expect(normaliseRoom('dm:codex~leader')).toBe('dm:codex~leader');
  });

  it('agrees with dmId, which is the id everything else builds', () => {
    expect(normaliseRoom('dm:leader~codex')).toBe(dmId('leader', 'codex'));
  });

  it('leaves every other room kind exactly as it found it', () => {
    // The neighbouring case. A normaliser that rewrote `task:` or `dispute:`
    // ids would silently reroute the rooms the protocol depends on.
    for (const room of ['#floor', 'task:T-01', 'dispute:C-118', 'task:b~a']) {
      expect(normaliseRoom(room)).toBe(room);
    }
  });

  it('does not change who is in the room', () => {
    const s = stateWith(['leader', 'codex']);
    expect(membersOf(normaliseRoom('dm:leader~codex'), s).sort()).toEqual(
      membersOf('dm:codex~leader', s).sort(),
    );
  });

  it('leaves a malformed dm id alone rather than inventing a room', () => {
    // Better a refusal downstream, where the message names the real problem,
    // than a normaliser quietly turning a broken id into a plausible one.
    expect(normaliseRoom('dm:solo')).toBe('dm:solo');
    expect(normaliseRoom('dm:a~b~c')).toBe('dm:a~b~c');
  });
});

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
    specRefs: ['�4.2'],
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