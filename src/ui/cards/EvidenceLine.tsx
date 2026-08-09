import { createElement, useState } from 'react';
import type { Evidence } from '../../contracts/claim.js';

export interface EvidenceLineProps {
  evidence: Evidence;
  stale?: boolean;
}

function labelFor(evidence: Evidence): string {
  if (evidence.kind === 'command') return evidence.command ?? 'command';
  if (evidence.kind === 'file') return evidence.ref ?? 'file reference';
  return evidence.ref ?? 'observation';
}

export function EvidenceLine({ evidence, stale = evidence.stale ?? false }: EvidenceLineProps) {
  const [expanded, setExpanded] = useState(false);
  const label = labelFor(evidence);
  const output = evidence.output ?? evidence.ref ?? 'No recorded output.';
  const state = stale ? 'stale' : 'fresh';

  return createElement(
    'div',
    {
      className: `evidence-line${stale ? ' evidence-line-stale' : ''}`,
      'data-evidence-state': state,
      'data-testid': stale ? `evidence-stale-${evidence.sha}` : `evidence-${evidence.sha}`,
    },
    createElement(
      'button',
      {
        type: 'button',
        className: 'evidence-toggle',
        'aria-expanded': expanded ? 'true' : 'false',
        onClick: () => setExpanded((current) => !current),
      },
      createElement('span', { className: 'evidence-label' }, label),
      createElement('span', { className: 'evidence-sha' }, stale ? createElement('s', null, `@${evidence.sha}`) : `@${evidence.sha}`),
      createElement('span', { className: 'evidence-state' }, state),
    ),
    expanded ? createElement('pre', { className: 'evidence-output', 'data-testid': 'evidence-output' }, output) : null,
  );
}
