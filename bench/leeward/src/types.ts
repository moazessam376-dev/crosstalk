export type FishState = 'swimming' | 'landed';

export interface Fish {
  id: string;
  kind: string;
  state: FishState;
}

export interface Wind {
  heading: number;
  knots: number;
}

export const CATCH_TRANSITIONS: Record<FishState, readonly FishState[]> = {
  swimming: ['landed'],
  landed: [],
};

export function canCatch(from: FishState, to: FishState): boolean {
  return CATCH_TRANSITIONS[from].includes(to);
}
