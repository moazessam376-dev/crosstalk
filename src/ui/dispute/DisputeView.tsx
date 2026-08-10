import { createElement, useState } from 'react';
import type { Claim } from '../../contracts/claim.js';
import type { LadderRung } from '../../contracts/decision.js';
import type { CrosstalkEvent } from '../../contracts/events.js';
import type { ParticipantId } from '../../contracts/participant.js';
import type { PostResult } from '../state/humanAction.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ClaimCard } from '../cards/ClaimCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import type { ClaimResponseView } from '../cards/ClaimCard.js';

type ClaimResponseEvent = Extract<CrosstalkEvent, { kind: 'claim_response' }>;
type DecisionOpenedEvent = Extract<CrosstalkEvent, { kind: 'decision_opened' }>;
type TestProposedEvent = Extract<CrosstalkEvent, { kind: 'test_proposed' }>;

export type DisputeAction =
  | { type: 'propose_test' }
  | { type: 'intervene_human' };

export interface DisputeViewProps {
  roomId: string;
  events: CrosstalkEvent[];
  /**
   * `policy.dispute.maxRounds`, served by the daemon at `/config.json`.
   *
   * Undefined in fixture mode — `vite dev`, a static build, every UI test —
   * and the header then shows the round with no denominator. It must never
   * fall back to 3: that is the hard-coded constant this field replaces, and a
   * default would hide the regression it exists to expose.
   */
  maxRounds?: number;
  /** Who this browser posts as. The vote control appears only for a named voter. */
  self?: string;
  /** Absent when no daemon is attached — the control is hidden rather than inert. */
  onVote?: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
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

/**
 * The decision the rail and tally describe: the most recent one carrying a
 * ladder. A room can hold more than one open decision — C-3's idempotence guard
 * bounds *ladder* decisions to one per claim, but nothing stops an agent
 * opening an ordinary one alongside it — and a rail reading "the latest
 * decision" would go blank the moment that happened.
 */
function latestDecision(events: readonly CrosstalkEvent[]): DecisionOpenedEvent | undefined {
  const opened = events.filter((event): event is DecisionOpenedEvent => event.kind === 'decision_opened');
  return opened.filter((event) => event.decision.ladder !== undefined).at(-1) ?? opened.at(-1);
}

/**
 * Every open decision this participant may vote on. Spec §10.3 says *any*
 * decision they are eligible for, and eligibility is the decision's own
 * `voters` list — which is what the daemon enforces with NOT_ELIGIBLE_VOTER.
 */
function openDecisionsFor(events: readonly CrosstalkEvent[], self: string | undefined): DecisionOpenedEvent[] {
  if (self === undefined) return [];
  const resolved = new Set(
    events.filter((event) => event.kind === 'decision_resolved').map((event) => event.decisionId),
  );
  return events.filter(
    (event): event is DecisionOpenedEvent =>
      event.kind === 'decision_opened'
      && !resolved.has(event.decision.id)
      && event.decision.voters.includes(self),
  );
}

/**
 * The round this dispute is actually on.
 *
 * Never clamped. A dispute at round 5 of 3 reads `5 / 3`, because that is what
 * happened — clamping to the maximum made the display disagree with the
 * escalation that had already fired.
 */
function roundFor(claims: readonly ClaimView[]): number {
  const authoredRounds = claims.reduce((current, view) => Math.max(current, view.claim.rounds), 0);
  const observedResponses = claims.reduce((current, view) => Math.max(current, view.responses.length), 0);
  return Math.max(authoredRounds, observedResponses);
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

type RungState = 'current' | 'skipped' | 'failed' | 'pending';

interface RailRung {
  rung: LadderRung;
  index: number;
  state: RungState;
  /** Why it was skipped, or why it failed. Never rendered blank. */
  reason?: string;
}

/**
 * The escalation ladder as a rail of positions.
 *
 * Rule 1 of the contract freeze: the current rung is the `index` of the last
 * `rung_entered` for this decision, and `decision.currentRung` is only the
 * fallback. That field is an open-time snapshot on an append-only log, so a
 * rail reading it alone shows the opening rung forever while the ladder climbs
 * underneath it.
 *
 * `rung_failed.index` is the failed position, read directly. It used to be
 * recovered by pairing each failure to the nearest preceding `rung_entered` of
 * the same name, which held only while every failure followed an entry — and a
 * rung that fails *at* entry, with no uninvolved peer available, is a natural
 * thing to emit bare. The contract carries the position now.
 */
function buildRail(
  events: readonly CrosstalkEvent[],
  decision: DecisionOpenedEvent,
): { rungs: RailRung[]; adjudicator?: ParticipantId } {
  const { id, ladder = [], currentRung, skipped = [] } = decision.decision;

  const failedByIndex = new Map<number, string>();
  let lastEntered: Extract<CrosstalkEvent, { kind: 'rung_entered' }> | undefined;
  for (const event of events) {
    if (event.kind === 'rung_entered' && event.decisionId === id) lastEntered = event;
    if (event.kind === 'rung_failed' && event.decisionId === id) failedByIndex.set(event.index, event.reason);
  }

  const current = lastEntered?.index ?? currentRung ?? 0;
  const skippedByRung = new Map(skipped.map((entry) => [entry.rung, entry.reason]));

  // Skipping is name-scoped and correct that way: `resolvableRungs` filters
  // every instance of a rung, so if one is unreachable they all are. Failure is
  // the only one of the three that belongs to a single attempt.
  const rungs = ladder.map((rung, index): RailRung => {
    if (skippedByRung.has(rung)) return { rung, index, state: 'skipped', reason: skippedByRung.get(rung) };
    if (failedByIndex.has(index)) return { rung, index, state: 'failed', reason: failedByIndex.get(index) };
    if (index === current) return { rung, index, state: 'current' };
    return { rung, index, state: 'pending' };
  });

  return { rungs, adjudicator: lastEntered?.adjudicator };
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

/**
 * Commits other than the proposed one that answering evidence was gathered at.
 *
 * The rung's premise is that the command's result differs depending on who is
 * right. Two runs straddling a merge differ because of the diff between them,
 * and the rung would then record an inconclusive falsifier against both
 * participants when the real fault was that nobody named a commit. Saying it on
 * screen makes that a visible fact rather than a silent one.
 */
function divergentShas(events: readonly CrosstalkEvent[], proposal: TestProposedEvent): string[] {
  const shas = new Set<string>();
  for (const event of events) {
    // A competing proposal at another commit is the sharper case, and the one
    // C-11 was argued on: the rung is already doomed before anyone runs
    // anything. Order does not matter here — either proposal names a commit the
    // other disagrees with.
    if (
      event.kind === 'test_proposed'
      && event.decisionId === proposal.decisionId
      && event.seq !== proposal.seq
      && event.sha !== proposal.sha
    ) {
      shas.add(event.sha);
    }
    if (event.seq <= proposal.seq) continue;
    if (event.kind === 'evidence_added' && event.claimId === proposal.claimId && event.evidence.sha !== proposal.sha) {
      shas.add(event.evidence.sha);
    }
    if (event.kind === 'claim_response' && event.claimId === proposal.claimId) {
      for (const item of event.evidence ?? []) {
        if (item.sha !== proposal.sha) shas.add(item.sha);
      }
    }
  }
  return [...shas];
}

interface VoteControlProps {
  decisionId: string;
  /** Named, because more than one decision can be open at once. */
  question: string;
  options: readonly string[];
  onVote: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
}

/**
 * The human's ruling on an open decision.
 *
 * The rationale is required here rather than discovered from the daemon's
 * `VOTE_WITHOUT_RATIONALE`: a round-trip to learn that a field was mandatory is
 * a worse experience than a field that says so. It is also the same burden
 * every other participant carries — a ruling is a claim (spec §5.3).
 */
function VoteControl({ decisionId, question, options, onVote }: VoteControlProps) {
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const ready = rationale.trim().length > 0;

  async function cast(option: string): Promise<void> {
    if (!ready) return;
    const result = await onVote(decisionId, option, rationale.trim());
    if (result.ok) {
      setRationale('');
      setError(undefined);
      return;
    }
    setError(result.reason);
  }

  return createElement(
    'section',
    { className: 'vote-control', 'data-testid': `vote-control-${decisionId}`, 'aria-label': 'cast your vote' },
    createElement('h3', null, 'your ruling'),
    createElement('p', { className: 'vote-question' }, question),
    createElement('textarea', {
      className: 'vote-rationale',
      'data-testid': `vote-rationale-${decisionId}`,
      'aria-label': 'why you are ruling this way',
      placeholder: 'Why. A vote without a reason is not a ruling.',
      rows: 2,
      value: rationale,
      onChange: (event: { target: { value: string } }) => setRationale(event.target.value),
    }),
    createElement(
      'div',
      { className: 'vote-options' },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option,
            type: 'button',
            className: 'vote-option',
            'data-testid': `vote-option-${decisionId}-${option}`,
            disabled: !ready,
            onClick: () => void cast(option),
          },
          option,
        ),
      ),
    ),
    error === undefined
      ? null
      : createElement('p', { className: 'vote-error', role: 'alert', 'data-testid': 'vote-error' }, error),
  );
}

export function DisputeView({ roomId, events, maxRounds, self, onVote, onHumanAction }: DisputeViewProps) {
  const ordered = events.slice().sort((left, right) => left.seq - right.seq);
  const scopedEvents = roomEvents(ordered, roomId);
  const claims = collectClaims(ordered, scopedEvents, roomId);
  const decision = latestDecision(scopedEvents);
  const rail = decision ? buildRail(scopedEvents, decision) : { rungs: [], adjudicator: undefined };
  const proposedTests = scopedEvents.filter((event): event is TestProposedEvent => event.kind === 'test_proposed');
  const votable = onVote === undefined ? [] : openDecisionsFor(scopedEvents, self);
  const counts = decision ? voteCounts(scopedEvents, decision) : new Map<string, number>();
  const round = roundFor(claims);
  const primary = claims[0];
  // The right pane is the *other side*, never the claimant restating itself.
  // Pairing `claims[0]` with `responses.at(-1)` put "CLAIM · leader" beside
  // "UPHOLD · leader" and dropped the contesting worker's falsifier from the
  // one screen the design exists for (spec §10.2).
  const latestResponse = primary?.responses.filter((response) => response.from !== primary.claim.raisedBy).at(-1);
  // An uphold is new evidence on the claim, so it lands in the claim pane —
  // it does not get to replace the opposing pane.
  const raiserEvidence = (primary?.responses ?? [])
    .filter((response) => response.from === primary?.claim.raisedBy)
    .flatMap((response) => response.evidence ?? []);
  const evidence = primary ? [...primary.claim.evidence, ...primary.extraEvidence, ...raiserEvidence] : [];
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
      createElement(
        'span',
        { className: 'round-counter fact', 'data-max-rounds': maxRounds === undefined ? 'unknown' : String(maxRounds) },
        maxRounds === undefined ? `round ${round}` : `round ${round} / ${maxRounds}`,
      ),
    ),
    decision
      ? createElement(
          'div',
          { className: 'ladder' },
          createElement(
            'ol',
            { className: 'ladder-rail', 'data-testid': 'ladder-rail' },
            rail.rungs.map((entry) =>
              createElement(
                'li',
                {
                  key: `${entry.rung}-${entry.index}`,
                  className: `ladder-rung ladder-rung-${entry.state}`,
                  'data-rung': entry.rung,
                  'data-index': String(entry.index),
                  'data-state': entry.state,
                  'data-current': entry.state === 'current' ? 'true' : 'false',
                  // Skipped, never silent — a degraded ladder must not look
                  // like a short one (audit F-07).
                  ...(entry.reason === undefined ? {} : { title: entry.reason }),
                  'data-testid': `ladder-rung-${entry.rung}`,
                },
                labelForRung(entry.rung),
              ),
            ),
          ),
          rail.adjudicator === undefined
            ? null
            : createElement(
                'p',
                { className: 'ladder-adjudicator fact', 'data-testid': 'ladder-adjudicator' },
                `adjudicator: ${rail.adjudicator}`,
              ),
        )
      : null,
    proposedTests.length === 0
      ? null
      : createElement(
          'section',
          { className: 'test-proposals', 'data-testid': 'test-proposals' },
          createElement('h3', null, 'discriminating test'),
          proposedTests.map((proposal) => {
            const divergent = divergentShas(scopedEvents, proposal);
            return createElement(
              'article',
              { key: proposal.seq, className: 'test-proposal', 'data-testid': `test-proposal-${proposal.seq}` },
              createElement('span', { className: 'proposal-by' }, proposal.from),
              createElement('p', { className: 'proposal-command fact' }, proposal.command),
              createElement(
                'div',
                { className: 'proposal-predicts' },
                createElement('span', { className: 'fact-label' }, 'predicts'),
                createElement('p', null, proposal.predicts),
              ),
              createElement('span', { className: 'proposal-sha fact' }, proposal.sha),
              divergent.length === 0
                ? null
                : createElement(
                    'p',
                    {
                      className: 'proposal-divergence',
                      'data-testid': `test-proposal-${proposal.seq}-divergence`,
                    },
                    `answered at a different commit: ${divergent.join(', ')}`,
                  ),
            );
          }),
        ),
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
    onVote === undefined
      ? null
      : votable.map((open) =>
          createElement(VoteControl, {
            key: open.decision.id,
            decisionId: open.decision.id,
            question: open.decision.question,
            options: open.decision.options,
            onVote,
          }),
        ),
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
