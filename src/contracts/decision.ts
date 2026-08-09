import type { ParticipantId } from './participant.js';

/**
 * Rungs of an escalation ladder, tried in order.
 * `discriminating_test` first because most disputes about code are
 * empirically decidable and evidence beats argument.
 */
export type LadderRung =
  | 'discriminating_test'
  | 'third_agent'
  | 'leader'
  | 'human'
  | 'vote';

export type DecisionMethod =
  | 'unanimous'
  | 'majority'
  | 'leader'
  | 'human'
  | 'discriminating_test'
  | 'ladder';

/**
 * Rungs that always produce an outcome. A ladder must end on one of these
 * or a dispute can fall off the end unresolved.
 */
export const TERMINAL_RUNGS: readonly LadderRung[] = ['leader', 'human', 'vote'];

export interface Rationale {
  by: ParticipantId;
  text: string;
}

export interface Decision {
  /** "D-07" */
  id: string;
  question: string;
  options: string[];
  voters: ParticipantId[];
  method: DecisionMethod;
  /** Present when `method` is "ladder". */
  ladder?: LadderRung[];
  /** Index into `ladder`. */
  currentRung?: number;
  /** ISO-8601. */
  deadline?: string;
  outcome?: string;
  rationale: Rationale[];
  /** Set when this decision resolves a contested claim. */
  claimId?: string;
  votes: Record<ParticipantId, string>;
}
