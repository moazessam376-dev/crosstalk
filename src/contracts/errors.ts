export type ErrorCode =
  // The falsifiability rules. Weakening any of these is a defect.
  | 'MISSING_FALSIFIER'
  | 'VACUOUS_FALSIFIER'
  | 'CONTEST_WITHOUT_RATIONALE'
  | 'CONTEST_WITHOUT_COUNTER_EVIDENCE'
  | 'UPHOLD_WITHOUT_NEW_EVIDENCE'
  // Task gates.
  | 'GATE_NOT_ACKNOWLEDGED'
  | 'GATE_NOT_SELF_REVIEWED'
  | 'ILLEGAL_TRANSITION'
  | 'UNRESOLVED_CLAIMS'
  // Decisions.
  | 'NON_TERMINAL_LADDER'
  | 'NOT_ELIGIBLE_VOTER'
  | 'VOTE_WITHOUT_RATIONALE'
  // Lookups.
  | 'UNKNOWN_CLAIM'
  | 'UNKNOWN_TASK'
  | 'UNKNOWN_DECISION'
  | 'UNKNOWN_PARTICIPANT';

/**
 * Thrown at the API boundary so an agent sees the failure in-band, in its own
 * language, and retries — rather than a prompt rule it forgot forty turns ago.
 */
export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
