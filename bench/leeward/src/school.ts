import { canCatch, type Fish, type FishState } from './types.js';

/** Ten fish in the water. At least one already landed is not required. */
export const SCHOOL: Fish[] = [
  { id: 'F-1', kind: 'mackerel', state: 'swimming' },
  { id: 'F-2', kind: 'herring', state: 'swimming' },
  { id: 'F-3', kind: 'cod', state: 'swimming' },
  { id: 'F-4', kind: 'pollock', state: 'swimming' },
  { id: 'F-5', kind: 'hake', state: 'swimming' },
  { id: 'F-6', kind: 'whiting', state: 'swimming' },
  { id: 'F-7', kind: 'plaice', state: 'swimming' },
  { id: 'F-8', kind: 'sole', state: 'swimming' },
  { id: 'F-9', kind: 'bass', state: 'swimming' },
  { id: 'F-10', kind: 'mullet', state: 'swimming' },
];

export class IllegalCatchError extends Error {
  readonly code = 'ILLEGAL_CATCH';
  constructor(from: FishState, to: FishState) {
    super(`Illegal catch: ${from} -> ${to}`);
    this.name = 'IllegalCatchError';
  }
}

export class School {
  readonly #rows: Fish[] = [];

  constructor(seed: readonly Fish[] = SCHOOL) {
    this.#rows = seed.map((row) => ({ ...row }));
  }

  list(): Fish[] {
    return this.#rows.map((row) => ({ ...row }));
  }

  landed(): number {
    return this.#rows.filter((row) => row.state === 'landed').length;
  }

  catch(id: string): Fish {
    const row = this.#rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`Unknown fish: ${id}`);
    if (!canCatch(row.state, 'landed')) throw new IllegalCatchError(row.state, 'landed');
    row.state = 'landed';
    return { ...row };
  }
}
