import type { Claim, ClaimResolution, ClaimVerdict } from '../contracts/claim.js';
import type { Decision } from '../contracts/decision.js';
import type { CrosstalkEvent } from '../contracts/events.js';
import type { Participant, ParticipantId } from '../contracts/participant.js';
import type { Task } from '../contracts/task.js';

export interface HubState {
  participants: Map<ParticipantId, Participant>;
  tasks: Map<string, Task>;
  claims: Map<string, Claim>;
  decisions: Map<string, Decision>;
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
      state.messages.push({ ...event, ts: '' });
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
        state.claims.set(event.claimId, {
          ...claim,
          evidence: claim.evidence.map((evidence) =>
            evidence.sha === event.sha ? { ...evidence, stale: true } : evidence,
          ),
        });
      }
      return state;
    }
    case 'rebase_notice':
      return state;
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
    case 'brief_updated':
      return state;
  }

  throw new Error(`Unknown event kind: ${(event as { kind?: string }).kind ?? '<missing>'}`);
}

function emptyState(): HubState {
  return {
    participants: new Map(),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function stateForVerdict(verdict: ClaimVerdict): Claim['state'] {
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
