export type DecisionState = 'open' | 'resolved';

export interface Decision {
  id: string;
  title: string;
  state: DecisionState;
}

export const DECISION_TRANSITIONS: Record<DecisionState, readonly DecisionState[]> = {
  open: ['resolved'],
  resolved: [],
};

export function canTransition(from: DecisionState, to: DecisionState): boolean {
  return DECISION_TRANSITIONS[from].includes(to);
}
