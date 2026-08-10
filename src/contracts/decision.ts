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

/**
 * A rung that will not be attempted, and why.
 *
 * Named rather than removed: a ladder degraded because there was no uninvolved
 * peer to call must not look like a ladder somebody deliberately configured
 * short. Audit F-07.
 */
export interface SkippedRung {
  rung: LadderRung;
  reason: string;
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
  /**
   * Index into `ladder` at open time, set to `LadderPlan.start`.
   *
   * This is a snapshot and the log is append-only, so it never moves. The
   * *live* rung is the `index` of the last `rung_entered` for this decision,
   * falling back to this field when there is none. Consumers must use that
   * rule rather than reading this field alone, or a rail renders the opening
   * rung forever while the ladder climbs underneath it.
   */
  currentRung?: number;
  /** Rungs that will not be attempted. Populated at open time. */
  skipped?: SkippedRung[];
  /** ISO-8601. */
  deadline?: string;
  outcome?: string;
  rationale: Rationale[];
  /** Set when this decision resolves a contested claim. */
  claimId?: string;
  votes: Record<ParticipantId, string>;
}
