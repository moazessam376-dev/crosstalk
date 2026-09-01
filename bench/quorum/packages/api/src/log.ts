import { canTransition, type Decision, type DecisionState } from '../../types/src/index.js';
import { SEED } from './seed.js';

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(from: DecisionState, to: DecisionState) {
    super(`Illegal decision transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class DecisionLog {
  readonly #rows: Decision[] = [];

  constructor(seed: readonly Decision[] = SEED) {
    this.#rows = seed.map((row) => ({ ...row }));
  }

  list(): Decision[] {
    return this.#rows.map((row) => ({ ...row }));
  }

  move(id: string, to: DecisionState): Decision {
    const row = this.#rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`Unknown decision: ${id}`);
    if (!canTransition(row.state, to)) throw new IllegalTransitionError(row.state, to);
    row.state = to;
    return { ...row };
  }
}
