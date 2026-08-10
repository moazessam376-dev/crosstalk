import { createElement } from 'react';
import type { Claim } from '../../contracts/claim.js';
import type { CrosstalkEvent } from '../../contracts/events.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ClaimCard } from '../cards/ClaimCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { MessageCard } from '../cards/MessageCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ProtocolCard } from '../cards/ProtocolCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Composer } from './Composer.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { DisputeView } from '../dispute/DisputeView.js';
import type { PostResult } from '../state/humanAction.js';

export type HumanAction = { type: 'propose_test' | 'intervene_human' };

export interface StreamProps {
  events: CrosstalkEvent[];
  activeRoom?: string;
  /** `policy.dispute.maxRounds`, passed through to the dispute header. */
  maxRounds?: number;
  /** Who the daemon attributes this browser's posts to. */
  self?: string;
  /** Absent when no daemon is attached — the composer is hidden rather than inert. */
  onSend?: (body: string) => Promise<PostResult>;
  /** Absent when no daemon is attached. */
  onVote?: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
  onHumanAction?: (action: HumanAction) => void;
}

export function Stream({ events, activeRoom, maxRounds, self, onSend, onVote, onHumanAction }: StreamProps) {
  const visibleEvents = (activeRoom ? events.filter((event) => event.room === activeRoom) : events)
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const claims = new Map<string, Claim>();
  const staleShas = new Set<string>();

  for (const event of events) {
    if (event.kind === 'claim_raised') claims.set(event.claim.id, event.claim);
    if (event.kind === 'evidence_stale') staleShas.add(event.sha);
  }

  const cards = visibleEvents.map((event) => {
    if (event.kind === 'message') {
      return createElement(MessageCard, {
        key: String(event.seq) + '-' + event.kind,
        from: event.from,
        body: event.body,
        ts: event.ts,
        seq: event.seq,
        testId: 'card-message-' + event.seq,
      });
    }

    if (event.kind === 'claim_raised') {
      return createElement(ClaimCard, {
        key: String(event.seq) + '-' + event.kind,
        claim: event.claim,
        staleShas,
        testId: 'card-claim-' + event.claim.id,
      });
    }

    if (event.kind === 'claim_response') {
      const claim = claims.get(event.claimId);
      if (claim) {
        return createElement(ClaimCard, {
          key: String(event.seq) + '-' + event.kind,
          claim,
          response: {
            from: event.from,
            verdict: event.verdict,
            rationale: event.rationale,
            falsifier: event.falsifier,
            evidence: event.evidence,
          },
          staleShas,
          showControls: false,
          testId: 'card-claim-response-' + event.seq,
        });
      }
    }

    return createElement(ProtocolCard, {
      key: String(event.seq) + '-' + event.kind,
      event,
    });
  });

  return createElement(
    'section',
    { className: 'hub-region hub-stream', 'aria-label': 'event stream', 'data-testid': 'hub-region' },
    createElement('h2', null, activeRoom ?? 'Stream'),
    createElement('p', { className: 'stream-count' }, String(visibleEvents.length) + ' events'),
    activeRoom && activeRoom.startsWith('dispute:')
      ? createElement(DisputeView, { roomId: activeRoom, events, maxRounds, self, onVote, onHumanAction })
      : createElement('div', { className: 'card-stream' }, cards),
    // §10.3: a composer on every room, disputes included. It sits under the
    // stream rather than inside the dispute view so the human can speak
    // wherever they are looking.
    activeRoom && onSend
      ? createElement(Composer, { room: activeRoom, self, onSend })
      : null,
  );
}
