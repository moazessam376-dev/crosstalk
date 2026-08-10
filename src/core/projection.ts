import type { Claim, ClaimResolution, ClaimVerdict } from '../contracts/claim.js';
import type { Decision, LadderRung } from '../contracts/decision.js';
import type { CrosstalkEvent } from '../contracts/events.js';
import type { Participant, ParticipantId } from '../contracts/participant.js';
import type { Task } from '../contracts/task.js';

/** The live position of a ladder, from the last `rung_entered`. */
export interface RungState {
  rung: LadderRung;
  index: number;
  adjudicator?: ParticipantId;
}

export interface HubState {
  participants: Map<ParticipantId, Participant>;
  tasks: Map<string, Task>;
  claims: Map<string, Claim>;
  decisions: Map<string, Decision>;
  /**
   * By `decisionId`. `Decision.currentRung` is a snapshot taken at open time
   * and the log is append-only, so it never moves; the live rung is the last
   * `rung_entered`. Kept beside the decisions rather than folded into them so
   * the snapshot stays exactly what was written.
   */
  rungs: Map<string, RungState>;
  messages: CrosstalkEvent[];
  lastSeq: number;
}

export function project(events: CrosstalkEvent[]): HubState {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .reduce((state, event) => applyEvent(state, event), emptyState());
}

export function applyEvent(state: HubState, event: CrosstalkEvent): HubState {
  state.lastSeq = event.seq;

  switch (event.kind) {
    case 'participant_joined':
      state.participants.set(event.participant.id, { ...event.participant });
      return state;
    case 'participant_left':
      state.participants.delete(event.participantId);
      return state;
    case 'message':
      state.messages.push({ ...event });
      return state;
    case 'task_created':
      state.tasks.set(event.task.id, { ...event.task });
      return state;
    case 'task_state': {
      const task = state.tasks.get(event.taskId);
      if (task) {
        state.tasks.set(event.taskId, { ...task, state: event.state });
      }
      return state;
    }
    case 'brief_ack': {
      const task = state.tasks.get(event.taskId);
      if (task) {
        state.tasks.set(event.taskId, { ...task, acknowledgement: event.ack });
      }
      return state;
    }
    case 'self_review': {
      const task = state.tasks.get(event.taskId);
      if (task) {
        state.tasks.set(event.taskId, { ...task, critique: event.critique });
      }
      return state;
    }
    case 'claim_raised':
      state.claims.set(event.claim.id, { ...event.claim, evidence: [...event.claim.evidence] });
      return state;
    case 'claim_response': {
      const claim = state.claims.get(event.claimId);
      if (claim) {
        const resolution = resolutionForVerdict(event.verdict);
        state.claims.set(event.claimId, {
          ...claim,
          evidence: [...claim.evidence, ...event.evidence],
          rounds: claim.rounds + 1,
          state: stateForVerdict(event.verdict),
          // Derived here, never authored: the validator reads it to decide
          // whose turn it is, and a self-reported turn is not a turn.
          lastResponder: event.from,
          ...(resolution === undefined ? {} : { resolution }),
        });
      }
      return state;
    }
    case 'evidence_added': {
      const claim = state.claims.get(event.claimId);
      if (claim) {
        state.claims.set(event.claimId, { ...claim, evidence: [...claim.evidence, event.evidence] });
      }
      return state;
    }
    case 'evidence_stale': {
      const claim = state.claims.get(event.claimId);
      if (claim) {
        const next: Claim = {
          ...claim,
          evidence: claim.evidence.map((item) =>
            item.sha === event.sha ? { ...item, stale: true } : item,
          ),
        };
        if (hasNothingLeftToStandOn(next)) {
          next.state = 'open';
          // Deleted rather than set to `undefined`: an own key holding
          // `undefined` survives into serialised state, and the projection is
          // compared serialised.
          delete next.resolution;
        }
        state.claims.set(event.claimId, next);
      }
      return state;
    }
    case 'rebase_notice': {
      // Only from `submitted`. A task under review, accepted or merged is
      // somebody else's to move, and a task already being worked on has
      // nowhere to go.
      const task = state.tasks.get(event.taskId);
      if (task?.state === 'submitted') {
        state.tasks.set(event.taskId, { ...task, state: 'in_progress' });
      }
      return state;
    }
    case 'decision_opened':
      state.decisions.set(event.decision.id, { ...event.decision, votes: { ...event.decision.votes } });
      return state;
    case 'vote_cast': {
      const decision = state.decisions.get(event.decisionId);
      if (decision) {
        state.decisions.set(event.decisionId, {
          ...decision,
          votes: { ...decision.votes, [event.from]: event.option },
        });
      }
      return state;
    }
    case 'decision_resolved': {
      const decision = state.decisions.get(event.decisionId);
      if (decision) {
        state.decisions.set(event.decisionId, { ...decision, outcome: event.outcome });
      }
      return state;
    }
    case 'rung_entered':
      // The live rung. `Decision.currentRung` stays the open-time snapshot.
      state.rungs.set(event.decisionId, {
        rung: event.rung,
        index: event.index,
        ...(event.adjudicator === undefined ? {} : { adjudicator: event.adjudicator }),
      });
      return state;
    case 'test_proposed':
      return state;
    case 'rung_failed':
      return state;
    case 'brief_updated':
      return state;
  }

  throw new Error(`Unknown event kind: ${(event as { kind?: string }).kind ?? '<missing>'}`);
}

/**
 * Whether a resolved claim has just lost the last evidence that settled it.
 *
 * Spec §5.4: "a claim resolved solely by now-stale evidence reopens". One fresh
 * piece is enough to keep it settled — a resolution standing on evidence the
 * main branch still contains has not been undermined by a rebase somewhere
 * else in the tree.
 *
 * `withdrawn` and `superseded` are excluded for the same reason the daemon's
 * sweep excludes them: a conceded claim was abandoned by the person who raised
 * it and an amended one has a successor carrying the argument. Neither is
 * waiting on evidence, and resurrecting them would reopen an argument that
 * ended for reasons no rebase touches. `upheld` is precisely the case this
 * exists for.
 *
 * The `length > 0` guard is not decoration: `[].every(...)` is true, so without
 * it a claim that never carried any evidence would reopen on the first stale
 * event naming a sha it has never seen.
 */
function hasNothingLeftToStandOn(claim: Claim): boolean {
  if (claim.state !== 'resolved') return false;
  if (claim.resolution === 'withdrawn' || claim.resolution === 'superseded') return false;
  return claim.evidence.length > 0 && claim.evidence.every((item) => item.stale === true);
}

function emptyState(): HubState {
  return {
    participants: new Map(),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

/** Exported so tests can assert the UI's independent mapping agrees. */
export function stateForVerdict(verdict: ClaimVerdict): Claim['state'] {
  switch (verdict) {
    case 'accept':
      return 'resolved';
    case 'clarify':
      return 'clarify';
    case 'contest':
    case 'uphold':
      return 'contested';
    case 'concede':
      return 'resolved';
    case 'amend':
      return 'resolved';
  }

  throw new Error(`Unknown claim verdict: ${verdict satisfies never}`);
}

function resolutionForVerdict(verdict: ClaimVerdict): ClaimResolution | undefined {
  switch (verdict) {
    case 'accept':
      return 'upheld';
    case 'concede':
      return 'withdrawn';
    case 'amend':
      return 'superseded';
    case 'clarify':
    case 'contest':
    case 'uphold':
      return undefined;
  }

  throw new Error(`Unknown claim verdict: ${verdict satisfies never}`);
}
