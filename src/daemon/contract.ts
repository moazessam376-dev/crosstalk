import type { ErrorCode } from '../contracts/errors.js';
import type { CrosstalkEvent, EventKind } from '../contracts/events.js';
import type { DaemonErrorCode } from './errors.js';

/** Wire envelope for every failure. Contract §8. */
export interface WireError {
  error: {
    domain: 'protocol' | 'daemon';
    code: ErrorCode | DaemonErrorCode;
    message: string;
    /** Only on DAEMON_ALREADY_RUNNING. */
    url?: string;
  };
}

/** Every write route returns a list: `/ack`, `/vote` and `/shutdown` each produce more than one event. Contract §4.2. */
export interface WriteResponse {
  events: CrosstalkEvent[];
}

export interface EventsResponse {
  events: CrosstalkEvent[];
  /** The seq of the last event *in this response*, not the log tail, so a client paging with `since=lastSeq` cannot skip a gap. */
  lastSeq: number;
}

/**
 * 422 means the payload is not acceptable. 409 means the payload is fine and
 * the world is not in a state that permits it. 403 is authorisation.
 *
 * Declared `Record<ErrorCode, number>` on purpose: a code added to the frozen
 * contract without a status fails typecheck rather than falling through to a
 * 500 in production. Two codes arrived here after the contract was drafted.
 */
export const PROTOCOL_STATUS: Record<ErrorCode, number> = {
  MISSING_FALSIFIER: 422,
  VACUOUS_FALSIFIER: 422,
  CONTEST_WITHOUT_RATIONALE: 422,
  CONTEST_WITHOUT_COUNTER_EVIDENCE: 422,
  UPHOLD_WITHOUT_NEW_EVIDENCE: 422,
  NOT_CLAIM_RESPONDER: 403,
  ILLEGAL_CLAIM_RESPONSE: 409,
  GATE_NOT_ACKNOWLEDGED: 409,
  GATE_NOT_SELF_REVIEWED: 409,
  ILLEGAL_TRANSITION: 409,
  UNRESOLVED_CLAIMS: 409,
  PLAN_NOT_FROZEN: 409,
  NON_TERMINAL_LADDER: 422,
  NOT_ELIGIBLE_VOTER: 403,
  VOTE_WITHOUT_RATIONALE: 422,
  // 409, not 422: the payload is fine, the ladder is simply not at that rung.
  RUNG_NOT_ACTIVE: 409,
  NOT_ADJUDICATOR: 403,
  RULING_WITHOUT_FALSIFIER: 422,
  TEST_WITHOUT_PREDICTION: 422,
  NOT_TASK_AUTHORITY: 403,
  // 409, not 403: the agent is permitted to submit this task, and the working
  // tree is simply not in a state where the submit can be taken. Retryable
  // once the offending paths are moved or the declaration widened.
  SUBMIT_OUTSIDE_OWNERSHIP: 409,
  UNKNOWN_CLAIM: 404,
  UNKNOWN_TASK: 404,
  UNKNOWN_DECISION: 404,
  UNKNOWN_PARTICIPANT: 404,
};

export const DAEMON_STATUS: Record<DaemonErrorCode, number> = {
  MALFORMED_BODY: 400,
  MALFORMED_CONFIG: 500,
  UNAUTHENTICATED: 401,
  FROM_NOT_ALLOWED: 403,
  NOT_A_ROOM_MEMBER: 403,
  ROLE_NOT_PERMITTED: 403,
  UNKNOWN_ROUTE: 404,
  NO_MIRRORED_SESSION: 404,
  SESSION_CANNOT_TAKE_TURN: 409,
  DAEMON_ALREADY_RUNNING: 409,
  PORT_IN_USE: 409,
  // Startup only, like PORT_IN_USE — thrown by `startDaemon`, never reaching
  // HTTP. Mapped because the map is total over DaemonErrorCode on purpose.
  PORT_BLOCKED: 409,
  HOST_UNAVAILABLE: 409,
  UNKNOWN_RUN: 404,
  RUN_NOT_ARCHIVABLE: 409,
  RUN_NOT_CONFIRMED: 409,
  PAYLOAD_TOO_LARGE: 413,
  MESSAGE_TOO_LONG: 422,
  MESSAGE_REFUSED: 422,
  EVENT_KIND_NOT_APPENDABLE: 422,
};

/** The only kind a client may hand to `POST /events`: it carries no invariant a validator defends. */
export const DIRECTLY_APPENDABLE: EventKind = 'message';

/**
 * Which route owns each kind. The rejection for a non-appendable kind quotes
 * this, so an agent that found the general endpoint is told where to go rather
 * than given a bare 400 — the failure worth defending against is a capable
 * client at the wrong door, not a hostile one.
 *
 * `Record<EventKind, string>` for the same reason as PROTOCOL_STATUS: a kind
 * added to the frozen contract without a route fails typecheck.
 */
export const EVENT_KIND_ROUTE: Record<EventKind, string> = {
  message: 'POST /events',
  claim_raised: 'POST /claims',
  claim_response: 'POST /claims/:id/response',
  evidence_added: 'POST /claims/:id/evidence',
  task_created: 'POST /tasks',
  brief_ack: 'POST /tasks/:id/ack',
  self_review: 'POST /tasks/:id/submit',
  task_state: 'POST /tasks/:id/state',
  decision_opened: 'POST /decisions',
  vote_cast: 'POST /decisions/:id/vote',
  test_proposed: 'POST /decisions/:id/test',
  // The ladder climbs on the daemon's own timers and state, never on a client
  // asking it to. An agent that could append `rung_entered` could skip a rung.
  rung_entered: 'no client route — emitted when the ladder advances',
  rung_failed: 'no client route — emitted when a rung times out or cannot run',
  // Emitted by the daemon from state it owns. No client route exists, by design:
  // presence, staleness and resolution are derived, never asserted by a client.
  participant_joined: 'no client route — derived from the presenting token',
  participant_left: 'no client route — emitted on shutdown',
  evidence_stale: 'no client route — emitted by the staleness check',
  decision_resolved: 'no client route — emitted when the tally resolves',
  rebase_notice: 'no client route — emitted on a conflicting merge',
  brief_updated: 'no client route — emitted when a brief is regenerated',
};

/** Author fields the daemon derives from the token. A body carrying one is rejected, never silently stripped. */
export const DERIVED_AUTHOR_FIELDS = ['from', 'raisedBy', 'by'] as const;
