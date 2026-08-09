import { createElement } from 'react';
import type { Claim } from '../../contracts/claim.js';
import type { CrosstalkEvent } from '../../contracts/events.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ClaimCard } from '../cards/ClaimCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import type { ClaimResponseView } from '../cards/ClaimCard.js';

type ClaimResponseEvent = Extract<CrosstalkEvent, { kind: 'claim_response' }>;
type DecisionOpenedEvent = Extract<CrosstalkEvent, { kind: 'decision_opened' }>;

export type DisputeAction =
  | { type: 'propose_test' }
  | { type: 'intervene_human' };

export interface DisputeViewProps {
  roomId: string;
  events: CrosstalkEvent[];
  onHumanAction?: (action: DisputeAction) => void;
}

interface ClaimView {
  claim: Claim;
  responses: ClaimResponseEvent[];
  staleShas: Set<string>;
  extraEvidence: Claim['evidence'];
}

function roomEvents(events: readonly CrosstalkEvent[], roomId: string): CrosstalkEvent[] {
  return events.filter((event) => event.room === roomId).sort((left, right) => left.seq - right.seq);
}

function collectClaims(
  events: readonly CrosstalkEvent[],
  scopedEvents: readonly CrosstalkEvent[],
  roomId: string,
): ClaimView[] {
  const relatedIds = new Set<string>();
  for (const event of scopedEvents) {
    if (event.kind === 'claim_raised') relatedIds.add(event.claim.id);
    if (event.kind === 'claim_response' || event.kind === 'evidence_added' || event.kind === 'evidence_stale') {
      relatedIds.add(event.claimId);
    }
    if (event.kind === 'decision_opened' && event.decision.claimId) {
      relatedIds.add(event.decision.claimId);
    }
  }

  const claims = new Map<string, ClaimView>();
  for (const event of events) {
    if (event.kind === 'claim_raised' && (event.room === roomId || relatedIds.has(event.claim.id))) {
      claims.set(event.claim.id, { claim: event.claim, responses: [], staleShas: new Set(), extraEvidence: [] });
    }
    if (event.kind === 'claim_response' && event.room === roomId) {
      claims.get(event.claimId)?.responses.push(event);
    }
    if (event.kind === 'evidence_added' && relatedIds.has(event.claimId)) {
      claims.get(event.claimId)?.extraEvidence.push(event.evidence);
    }
    if (event.kind === 'evidence_stale' && relatedIds.has(event.claimId)) {
      claims.get(event.claimId)?.staleShas.add(event.sha);
    }
  }
  return [...claims.values()];
}

function responseView(response: ClaimResponseEvent | undefined): ClaimResponseView | undefined {
  if (!response) return undefined;
  return {
    from: response.from,
    verdict: response.verdict,
    rationale: response.rationale,
    falsifier: response.falsifier,
    evidence: response.evidence,
  };
}

function latestDecision(events: readonly CrosstalkEvent[]): DecisionOpenedEvent | undefined {
  return events.filter((event): event is DecisionOpenedEvent => event.kind === 'decision_opened').at(-1);
}

function roundFor(claims: readonly ClaimView[]): number {
  const authoredRounds = claims.reduce((current, view) => Math.max(current, view.claim.rounds), 0);
  const observedResponses = claims.reduce((current, view) => Math.max(current, view.responses.length), 0);
  return Math.min(3, Math.max(authoredRounds, observedResponses));
}

/**
 * Must agree with `stateForVerdict` in src/core/projection.ts for every
 * verdict. The two are independent implementations of one protocol — that
 * boundary is deliberate, but it has now produced two divergences (a claim
 * shown `resolved` while the core said `contested`, and `accept` shown
 * `triaged` while the core said `resolved`). `tests/ui/verdict-parity.test.ts`
 * asserts they agree across the whole verdict union.
 */
export function displayState(view: ClaimView): Claim['state'] {
  if (view.claim.resolution) return 'resolved';
  const response = view.responses.at(-1);
  if (!response) return view.claim.state;
  switch (response.verdict) {
    case 'accept':
      return 'resolved';
    case 'clarify':
      return 'clarify';
    case 'concede':
    case 'amend':
      return 'resolved';
    case 'contest':
    case 'uphold':
      return 'contested';
  }
}

function labelForRung(rung: string): string {
  return rung.replaceAll('_', ' ');
}

function voteCounts(events: readonly CrosstalkEvent[], decision: DecisionOpenedEvent): Map<string, number> {
  const votes = new Map(Object.entries(decision.decision.votes));
  for (const event of events) {
    if (event.kind === 'vote_cast' && event.decisionId === decision.decision.id) {
      votes.set(event.from, event.option);
    }
  }

  const counts = new Map(decision.decision.options.map((option) => [option, 0]));
  for (const option of votes.values()) {
    counts.set(option, (counts.get(option) ?? 0) + 1);
  }
  return counts;
}

export function DisputeView({ roomId, events, onHumanAction }: DisputeViewProps) {
  const ordered = events.slice().sort((left, right) => left.seq - right.seq);
  const scopedEvents = roomEvents(ordered, roomId);
  const claims = collectClaims(ordered, scopedEvents, roomId);
  const decision = latestDecision(scopedEvents);
  const counts = decision ? voteCounts(scopedEvents, decision) : new Map<string, number>();
  const round = roundFor(claims);
  const primary = claims[0];
  const latestResponse = primary?.responses.at(-1);
  const evidence = primary ? [...primary.claim.evidence, ...primary.extraEvidence] : [];
  const claimWithEvidence = primary ? { ...primary.claim, evidence, state: displayState(primary) } : undefined;

  return createElement(
    'section',
    {
      className: 'dispute-view',
      'data-testid': 'dispute-view',
      'data-round': String(round),
      'aria-label': `dispute ${roomId}`,
    },
    createElement(
      'header',
      { className: 'dispute-header' },
      createElement('h2', null, roomId),
      createElement('span', { className: 'round-counter fact' }, `round ${round} / 3`),
    ),
    decision
      ? createElement(
          'ol',
          { className: 'ladder-rail', 'data-testid': 'ladder-rail' },
          (decision.decision.ladder ?? []).map((rung, index) =>
            createElement(
              'li',
              {
                key: rung,
                className: 'ladder-rung',
                'data-rung': rung,
                'data-current': decision.decision.currentRung === index ? 'true' : 'false',
                'data-testid': `ladder-rung-${rung}`,
              },
              labelForRung(rung),
            ),
          ),
        )
      : null,
    createElement(
      'div',
      { className: 'dispute-claims' },
      claimWithEvidence
        ? createElement(ClaimCard, {
            claim: claimWithEvidence,
            staleShas: primary?.staleShas,
            showControls: false,
            testId: `dispute-claim-${claimWithEvidence.id}`,
          })
        : createElement('p', { className: 'empty-fact' }, 'No claim has been raised in this room.'),
      claimWithEvidence && latestResponse
        ? createElement(ClaimCard, {
            claim: claimWithEvidence,
            response: responseView(latestResponse),
            staleShas: primary?.staleShas,
            showControls: false,
            testId: `dispute-response-${claimWithEvidence.id}`,
          })
        : null,
    ),
    decision
      ? createElement(
          'section',
          { className: 'vote-tally', 'data-testid': `vote-tally-${decision.decision.id}` },
          createElement('h3', null, 'decision tally'),
          createElement(
            'ul',
            null,
            [...counts.entries()].map(([option, count]) => createElement('li', { key: option }, createElement('span', null, option), createElement('strong', null, count))),
          ),
        )
      : null,
    createElement(
      'div',
      { className: 'dispute-actions', 'aria-label': 'human dispute controls' },
      createElement(
        'button',
        { type: 'button', 'data-testid': 'human-action-propose-test', onClick: () => onHumanAction?.({ type: 'propose_test' }) },
        'Propose discriminating test',
      ),
      createElement(
        'button',
        { type: 'button', 'data-testid': 'human-action-intervene', onClick: () => onHumanAction?.({ type: 'intervene_human' }) },
        'Intervene as @human',
      ),
    ),
  );
}
