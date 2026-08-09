import { createElement } from 'react';
import type { Claim, Evidence } from '../../contracts/claim.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { EvidenceLine } from './EvidenceLine.js';

export type ClaimActionType = 'accept' | 'contest' | 'clarify';

export interface ClaimAction {
  type: ClaimActionType;
  claimId: string;
}

export interface ClaimResponseView {
  from: string;
  verdict: string;
  rationale?: string;
  falsifier?: string;
  evidence: Evidence[];
}

export interface ClaimCardProps {
  claim: Claim;
  response?: ClaimResponseView;
  staleShas?: ReadonlySet<string>;
  onAction?: (action: ClaimAction) => void;
  showControls?: boolean;
  testId?: string;
}

export function ClaimCard({
  claim,
  response,
  staleShas,
  onAction,
  showControls = true,
  testId = `claim-card-${claim.id}`,
}: ClaimCardProps) {
  const isResponse = response !== undefined;
  const title = isResponse ? `${response.verdict.toUpperCase()} · ${response.from}` : `CLAIM · ${claim.raisedBy}`;
  const assertion = response?.rationale ?? claim.assertion;
  const falsifier = response?.falsifier ?? claim.falsifier;
  const evidence = response?.evidence ?? claim.evidence;

  return createElement(
    'article',
    {
      className: `claim-card${isResponse ? ' claim-response-card' : ''}`,
      'data-card-kind': isResponse ? 'claim-response' : 'claim',
      'data-claim-state': claim.state,
      'data-testid': testId,
    },
    createElement(
      'header',
      { className: 'claim-card-header' },
      createElement('h3', null, title),
      createElement('span', { className: `state-chip state-${claim.state}` }, claim.state),
      createElement('span', { className: `severity-chip severity-${claim.severity}` }, claim.severity),
    ),
    createElement('p', { className: 'claim-target fact' }, claim.target),
    createElement('p', { className: 'claim-assertion' }, assertion),
    createElement(
      'div',
      { className: 'claim-falsifier' },
      createElement('span', { className: 'fact-label' }, 'falsifier'),
      createElement('p', null, falsifier),
    ),
    createElement(
      'div',
      { className: 'claim-evidence' },
      createElement('span', { className: 'fact-label' }, 'evidence'),
      evidence.length > 0
        ? createElement(
            'ul',
            null,
            evidence.map((item) =>
              createElement(
                'li',
                { key: `${item.sha}-${item.command ?? item.ref ?? item.kind}` },
                createElement(EvidenceLine, { evidence: item, stale: staleShas?.has(item.sha) || item.stale }),
              ),
            ),
          )
        : createElement('p', { className: 'empty-fact' }, 'No evidence attached.'),
    ),
    showControls
      ? createElement(
          'div',
          { className: 'claim-controls', 'aria-label': 'claim controls' },
          (['accept', 'contest', 'clarify'] as const).map((type) =>
            createElement(
              'button',
              {
                key: type,
                type: 'button',
                className: `claim-action claim-action-${type}`,
                onClick: () => onAction?.({ type, claimId: claim.id }),
              },
              type.charAt(0).toUpperCase() + type.slice(1) + ' claim',
            ),
          ),
        )
      : null,
  );
}
