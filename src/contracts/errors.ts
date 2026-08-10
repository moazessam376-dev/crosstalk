export type ErrorCode =
  // The falsifiability rules. Weakening any of these is a defect.
  | 'MISSING_FALSIFIER'
  | 'VACUOUS_FALSIFIER'
  | 'CONTEST_WITHOUT_RATIONALE'
  | 'CONTEST_WITHOUT_COUNTER_EVIDENCE'
  | 'UPHOLD_WITHOUT_NEW_EVIDENCE'
  // Who may answer a claim, and with what. Both were a bare Error subclass
  // until Track D pointed out the daemon had nothing but a class name to map.
  | 'NOT_CLAIM_RESPONDER'
  | 'ILLEGAL_CLAIM_RESPONSE'
  // Task gates.
  | 'GATE_NOT_ACKNOWLEDGED'
  | 'GATE_NOT_SELF_REVIEWED'
  | 'ILLEGAL_TRANSITION'
  | 'UNRESOLVED_CLAIMS'
  // Plan formation, spec §5.6: a plan is not frozen while claims against it
  // are open, and work derived from a disputed plan inherits the dispute.
  | 'PLAN_NOT_FROZEN'
  // Decisions.
  | 'NON_TERMINAL_LADDER'
  | 'NOT_ELIGIBLE_VOTER'
  | 'VOTE_WITHOUT_RATIONALE'
  // The ladder. A rung is a state, so acting at the wrong one is a protocol
  // error the agent should see in-band and correct, not a transport complaint.
  | 'RUNG_NOT_ACTIVE'
  | 'NOT_ADJUDICATOR'
  | 'RULING_WITHOUT_FALSIFIER'
  | 'TEST_WITHOUT_PREDICTION'
  // Task authority. Legality and permission are different questions:
  // ILLEGAL_TRANSITION says the move is impossible, this says it is not yours.
  | 'NOT_TASK_AUTHORITY'
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
