import { TERMINAL_RUNGS } from '../contracts/decision.js';
import type { Decision, LadderRung } from '../contracts/decision.js';
import { ProtocolError } from '../contracts/errors.js';
import type { ParticipantId } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import type { HubState } from './projection.js';

export function validateLadder(ladder: LadderRung[]): void {
  if (!TERMINAL_RUNGS.includes(ladder.at(-1)!)) {
    throw new ProtocolError('NON_TERMINAL_LADDER', 'ladder must end on a terminal rung');
  }
}

export function resolvableRungs(ladder: LadderRung[], workerCount: number): LadderRung[] {
  if (workerCount < 2) {
    return ladder.filter((rung) => rung !== 'third_agent');
  }

  return [...ladder];
}

/**
 * `state` is required, not convenience: `Decision` carries `voters` and `votes`
 * and no roles, so nothing in the old signature could tell a leader from a
 * worker. The previous implementation returned the first voter who had voted
 * at all, which meant a worker's vote resolved a `method: 'leader'` decision —
 * a live bug, not only a ladder one.
 */
export function tally(decision: Decision, state: HubState): string | null {
  switch (decision.method) {
    case 'majority':
      return tallyMajority(decision);
    case 'unanimous':
      return tallyUnanimous(decision);
    case 'leader':
      return voteOf(leaderOf(state), decision);
    case 'human':
      return voteOf(HUMAN_ID, decision);
    case 'ladder':
      return tallyLadder(decision, state);
    default:
      return null;
  }
}

/**
 * The live rung decides, not the open-time snapshot: rule 1 of the freeze.
 * `discriminating_test` never resolves by vote — its success path is the claim
 * resolving, and its failure path is the rung timing out.
 */
function tallyLadder(decision: Decision, state: HubState): string | null {
  const current = currentRungOf(decision, state);
  if (current === undefined) return null;

  switch (current.rung) {
    case 'discriminating_test':
      return null;
    case 'third_agent':
      return current.adjudicator === undefined ? null : voteOf(current.adjudicator, decision);
    case 'leader':
      return voteOf(leaderOf(state), decision);
    case 'human':
      return voteOf(HUMAN_ID, decision);
    case 'vote':
      return tallyMajority(decision);
  }
}

/** Rule 1: the last `rung_entered`, falling back to the open-time snapshot. */
export function currentRungOf(
  decision: Decision,
  state: HubState,
): { rung: LadderRung; index: number; adjudicator?: ParticipantId } | undefined {
  const live = state.rungs.get(decision.id);
  if (live !== undefined) return live;

  const index = decision.currentRung ?? 0;
  const rung = decision.ladder?.[index];
  return rung === undefined ? undefined : { rung, index };
}

function voteOf(who: ParticipantId, decision: Decision): string | null {
  return decision.votes[who] ?? null;
}

function leaderOf(state: HubState): ParticipantId {
  for (const [id, participant] of state.participants) {
    if (participant.role === 'leader') return id;
  }
  return 'leader';
}

export function advance(decision: Decision): Decision {
  return {
    ...decision,
    currentRung: (decision.currentRung ?? 0) + 1,
  };
}

function tallyMajority(decision: Decision): string | null {
  const counts = new Map<string, number>();

  for (const voter of decision.voters) {
    const vote = decision.votes[voter];
    if (vote === undefined) {
      continue;
    }

    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }

  for (const [option, count] of counts) {
    if (count > decision.voters.length / 2) {
      return option;
    }
  }

  return null;
}

function tallyUnanimous(decision: Decision): string | null {
  if (decision.voters.length === 0) {
    return null;
  }

  const firstVote = decision.votes[decision.voters[0]!];
  if (firstVote === undefined) {
    return null;
  }

  for (const voter of decision.voters) {
    if (decision.votes[voter] !== firstVote) {
      return null;
    }
  }

  return firstVote;
}

