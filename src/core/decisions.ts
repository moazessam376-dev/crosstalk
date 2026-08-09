import { TERMINAL_RUNGS } from '../contracts/decision.js';
import type { Decision, LadderRung } from '../contracts/decision.js';
import { ProtocolError } from '../contracts/errors.js';

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

export function tally(decision: Decision): string | null {
  switch (decision.method) {
    case 'majority':
      return tallyMajority(decision);
    case 'unanimous':
      return tallyUnanimous(decision);
    case 'leader':
    case 'human':
      return authoritativeVote(decision);
    default:
      return null;
  }
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

function authoritativeVote(decision: Decision): string | null {
  for (const voter of decision.voters) {
    const vote = decision.votes[voter];
    if (vote !== undefined) {
      return vote;
    }
  }

  return null;
}
