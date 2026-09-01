import type { Participant, ParticipantId } from './participant.js';
import type { Claim, ClaimVerdict, Evidence } from './claim.js';
import type { Task, TaskState, Acknowledgement, CritiqueRecord } from './task.js';

/**
 * A file sent with a message, addressed by content.
 *
 * `sha` is the sha256 of the bytes, which is also where they are stored —
 * `.crosstalk/blobs/<sha[0:2]>/<sha><ext>` — so the same screenshot pasted
 * twice is one file, and a record cannot point at bytes that are not the ones
 * it was written about.
 *
 * `name` is the author's filename, kept for display only. It never becomes a
 * path: the extension on disk comes from a whitelist keyed on `type`, because
 * a filename is client input and a path built from client input is a
 * traversal waiting to happen.
 */
export interface MessageAttachment {
  /** sha256 of the bytes, lowercase hex. */
  sha: string;
  /** What the author called it. For display; never used to build a path. */
  name: string;
  /** The declared media type — `image/png`, `video/mp4`, `text/markdown`. */
  type: string;
  bytes: number;
}
import type { Decision, LadderRung } from './decision.js';
import type { RoomId } from './room.js';
import type { MessageTag } from './say.js';

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
  | (EventBase & {
      kind: 'message';
      room: RoomId;
      body: string;
      to?: ParticipantId;
      /**
       * An artifact carrying the depth this message points at — a path, a SHA,
       * a file the author wrote. The board carries the finding; `ref` carries
       * the evidence. Added so `SAY_LIMIT` compresses prose without costing
       * detail.
       */
      ref?: string;
      /**
       * What this message is for. See `core/says.ts`.
       *
       * The second named contract amendment, beside `spoc`. Optional, because
       * the log is append-only and every message written before it has none —
       * readers treat those as `note` and fall back to clipping `body`.
       */
      tag?: MessageTag;
      /**
       * The author's own one line, and the message proper.
       *
       * `MessageCard` has been asking for this field since it was written: a
       * clip at 320 characters is a guess at what mattered, and the author
       * knows. It arrives now because it is also the lever on length — a
       * mandatory `head` with an optional `body` makes one line the default
       * shape of a message, which a smaller cap could not.
       */
      head?: string;
      /** The slice or task this is about — `S-3`, `T-04`. */
      task?: string;
      /**
       * Files sent with the message: screenshots, mostly.
       *
       * The third named contract amendment, beside `spoc` and `tag`/`head`/
       * `task`. Optional for the same reason they are — the log is append-only
       * and every message written before this has none.
       *
       * **Deliberately not `ref`.** `ref` is single-valued, is *required* by
       * `result`, `gate` and `plan`, and `assertedGates` scans it for
       * `gate:<id>` — so an attachment put there would either displace a gate
       * assertion or be read as one. That is a correctness collision, not a
       * matter of taste.
       *
       * **The record carries the hash, never the path.** A machine-local path
       * in a log that `src/mirror/` pushes to GitHub is useless to the next
       * reader and leaks the author's directory layout. The absolute path is
       * derived at delivery, from the sha, by whoever is about to open it.
       */
      attachments?: readonly MessageAttachment[];
    })
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
      /**
       * Which ladder position failed. Carried rather than recovered by pairing
       * each failure to the nearest preceding `rung_entered` of the same name:
       * that convention holds only while every failure follows an entry, and a
       * rung that fails *at* entry — no uninvolved peer available — is a
       * natural thing to emit bare. A ladder may also repeat a rung, at which
       * point name-matching is ambiguous outright. The position is the fact;
       * deriving it was a rule nothing enforced.
       */
      index: number;
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

/**
 * The longest body `say` accepts from an agent.
 *
 * Beacon-1 measured the opposite failure: bodies were unbounded and delivery
 * was clipped to 120 characters, so the strongest seat had 95% of its output
 * dropped on the way to its teammates. Capping the author instead of the
 * reader keeps the whole message deliverable and puts the choice of what to cut
 * with the only party who knows — and `ref` means nothing has to be cut at all.
 *
 * `@human` is exempt: the operator posts the job, and a job brief is not chat.
 */
export const SAY_LIMIT = 1500;

/** null when the body is postable, otherwise the refusal an agent can act on. */
export function refuseOversizeBody(body: string, from: string): string | null {
  if (from === '@human') return null;
  if (body.length <= SAY_LIMIT) return null;
  return (
    `message is ${body.length} characters, over the ${SAY_LIMIT} limit. ` +
    'Post the finding and put the detail in an artifact, then name it with `ref`.'
  );
}
