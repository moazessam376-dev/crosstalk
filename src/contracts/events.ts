import type { Participant, ParticipantId } from './participant.js';
import type { Claim, ClaimVerdict, Evidence } from './claim.js';
import type { Task, TaskState, Acknowledgement } from './task.js';
import type { Decision } from './decision.js';
import type { RoomId } from './room.js';

export type EventKind =
  | 'participant_joined'
  | 'participant_left'
  | 'message'
  | 'task_created'
  | 'task_state'
  | 'brief_ack'
  | 'claim_raised'
  | 'claim_response'
  | 'evidence_added'
  | 'evidence_stale'
  | 'rebase_notice'
  | 'decision_opened'
  | 'vote_cast'
  | 'decision_resolved'
  | 'brief_updated';

export interface EventBase {
  /** Monotonic, assigned by the daemon. The only ordering that matters. */
  seq: number;
  /** ISO-8601. Display only — never order by this. */
  ts: string;
  from: ParticipantId;
  room?: RoomId;
}

export type CrosstalkEvent =
  // Carries the whole Participant, not just an id: the roster must be
  // derivable from the log alone, or an agent replaying it knows that
  // `codex-2` exists without knowing what it is.
  | (EventBase & { kind: 'participant_joined'; participant: Participant })
  | (EventBase & { kind: 'participant_left'; participantId: ParticipantId })
  | (EventBase & { kind: 'message'; room: RoomId; body: string; to?: ParticipantId })
  | (EventBase & { kind: 'task_created'; task: Task })
  | (EventBase & { kind: 'task_state'; taskId: string; state: TaskState; reason?: string })
  | (EventBase & { kind: 'brief_ack'; taskId: string; ack: Acknowledgement })
  | (EventBase & { kind: 'claim_raised'; claim: Claim })
  | (EventBase & {
      kind: 'claim_response';
      claimId: string;
      verdict: ClaimVerdict;
      rationale?: string;
      falsifier?: string;
      evidence: Evidence[];
    })
  | (EventBase & { kind: 'evidence_added'; claimId: string; evidence: Evidence })
  | (EventBase & { kind: 'evidence_stale'; claimId: string; sha: string })
  | (EventBase & { kind: 'rebase_notice'; taskId: string; newBase: string })
  | (EventBase & { kind: 'decision_opened'; decision: Decision })
  | (EventBase & { kind: 'vote_cast'; decisionId: string; option: string; rationale: string })
  | (EventBase & { kind: 'decision_resolved'; decisionId: string; outcome: string })
  | (EventBase & { kind: 'brief_updated'; participant: ParticipantId; version: string });

/**
 * Distributes over the union so each member keeps its own discriminant.
 * A plain `Omit<CrosstalkEvent, ...>` would collapse the union into one
 * object type and lose narrowing on `kind`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as authored, before the daemon stamps ordering. */
export type DraftEvent = DistributiveOmit<CrosstalkEvent, 'seq' | 'ts'>;
