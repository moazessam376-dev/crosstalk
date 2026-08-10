import type { Participant, ParticipantId } from './participant.js';
import type { Claim, ClaimVerdict, Evidence } from './claim.js';
import type { Task, TaskState, Acknowledgement, CritiqueRecord } from './task.js';
import type { Decision, LadderRung } from './decision.js';
import type { RoomId } from './room.js';

export type EventKind =
  | 'participant_joined'
  | 'participant_left'
  | 'message'
  | 'task_created'
  | 'task_state'
  | 'brief_ack'
  | 'self_review'
  | 'claim_raised'
  | 'claim_response'
  | 'evidence_added'
  | 'evidence_stale'
  | 'rebase_notice'
  | 'decision_opened'
  | 'vote_cast'
  | 'decision_resolved'
  // The ladder, made observable. Without these, a dispute that escalated
  // through three rungs and one that never left the first are the same log.
  | 'rung_entered'
  | 'test_proposed'
  | 'rung_failed'
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
  // Gate 2's counterpart to brief_ack. Without it nothing can set
  // Task.critique, so validateTransition refuses every path to `submitted`
  // and gate 2 is unreachable through the log — which it was until Track D
  // noticed while writing the daemon contract.
  | (EventBase & { kind: 'self_review'; taskId: string; critique: CritiqueRecord })
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
  // `room` required for the same reason as the decision events below, and
  // missed on the first pass. A claim resolved `upheld` returns to `open` when
  // its evidence is orphaned — so somebody has to answer it again, and that
  // participant is parked in `await_turn`. A roomless `evidence_stale` wakes
  // nobody: the claim silently reopens and the one person who must act on it is
  // the one person not told. `dispute:<claimId>`, already the convention.
  | (EventBase & { kind: 'evidence_stale'; room: RoomId; claimId: string; sha: string })
  // Same shape: `task:<taskId>`. The prose said so; now the compiler does.
  | (EventBase & { kind: 'rebase_notice'; room: RoomId; taskId: string; newBase: string })
  // `room` is required on every decision event, not inherited as optional from
  // EventBase. `addressesParticipant` wakes a participant only for an event
  // carrying a room they are in, so a roomless decision reached nobody: a voter
  // parked in `await_turn` was never told the vote it was named in existed.
  // Requiring it makes the compiler find every append site, rather than a
  // reviewer finding one of them.
  | (EventBase & { kind: 'decision_opened'; room: RoomId; decision: Decision })
  | (EventBase & {
      kind: 'vote_cast';
      room: RoomId;
      decisionId: string;
      option: string;
      rationale: string;
      /** Required at the `third_agent` rung: a ruling is a claim and carries
       *  the same burden as any other (spec §5.3). */
      falsifier?: string;
    })
  | (EventBase & { kind: 'decision_resolved'; room: RoomId; decisionId: string; outcome: string })
  | (EventBase & {
      kind: 'rung_entered';
      room: RoomId;
      decisionId: string;
      rung: LadderRung;
      index: number;
      /**
       * Who is authoritative at this rung. Set for `third_agent`, and chosen
       * *here* rather than at open time: "uninvolved" is a property that decays
       * — the peer picked when the ladder opened may have raised or received
       * its own claim before rung 2 is reached.
       */
      adjudicator?: ParticipantId;
    })
  | (EventBase & {
      kind: 'test_proposed';
      room: RoomId;
      decisionId: string;
      claimId: string;
      command: string;
      /** What the proposer says this prints if they are right. A command
       *  nobody has predicted an outcome for discriminates nothing. */
      predicts: string;
      /**
       * The commit `predicts` is asserted at. Required, for the same reason
       * `Evidence.sha` is: two disputants running one command at two commits
       * get a difference explained by the diff between them, not by who is
       * right — and the rung then records an inconclusive falsifier against
       * both when the real fault was that nobody named a commit.
       */
      sha: string;
    })
  | (EventBase & {
      kind: 'rung_failed';
      room: RoomId;
      decisionId: string;
      rung: LadderRung;
      reason: string;
    })
  | (EventBase & { kind: 'brief_updated'; participant: ParticipantId; version: string });

/**
 * Distributes over the union so each member keeps its own discriminant.
 * A plain `Omit<CrosstalkEvent, ...>` would collapse the union into one
 * object type and lose narrowing on `kind`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as authored, before the daemon stamps ordering. */
export type DraftEvent = DistributiveOmit<CrosstalkEvent, 'seq' | 'ts'>;
