import type { Claim, Evidence } from '../contracts/claim.js';
import type { Decision } from '../contracts/decision.js';

export interface MirrorComment {
  /** GitHub's own field, present on reads and unused on writes. */
  authorAssociation?: string;
  id: number;
  body: string;
}

/**
 * The mirror's handle on its own writes.
 *
 * It does two jobs, and the second is why it is a marker rather than a stored
 * comment id. Outbound, it lets the mirror find the comment for a claim and
 * edit it in place after a restart, with no state on disk to go stale.
 * Inbound, it is how the poller tells its own writes from a human's: every
 * participant here posts under the repository owner's credential, so author
 * and `author_association` cannot separate them (design §8's echo-loop rule
 * would otherwise be unimplementable).
 */
export function claimMarker(claimId: string): string {
  return `<!-- crosstalk:claim:${claimId} -->`;
}

/** Any mirror-authored comment, whatever it is about. Used by the inbound filter. */
export const MIRROR_MARKER_PREFIX = '<!-- crosstalk:';

export function isMirrorAuthored(body: string): boolean {
  return body.includes(MIRROR_MARKER_PREFIX);
}

function renderEvidence(evidence: readonly Evidence[]): string[] {
  if (evidence.length === 0) return ['_No evidence recorded._'];

  return evidence.map((item) => {
    const what = item.command ?? item.ref ?? item.output ?? 'observation';
    const stale = item.stale === true ? ' — **stale**' : '';
    return `- \`${what}\` at \`${item.sha}\` (${item.by})${stale}`;
  });
}

/**
 * One comment per claim, rewritten from scratch on every change and PATCHed
 * over the previous body. Appending a reply per round would turn a five-round
 * dispute into five comments nobody reads in order.
 */
export function renderClaimComment(claim: Claim, decision?: Decision): string {
  const against = claim.against === 'brief' || claim.against === 'spec' ? `the ${claim.against}` : `\`${claim.against}\``;

  // `rounds` belongs in the heading, not only in the resolution line. The
  // mirror skips a write whose body already matches, so without it round 1 and
  // round 2 of a contested claim render byte-identically and the comment stops
  // updating halfway through the dispute — while looking perfectly current.
  const round = claim.rounds > 0 ? ` · round ${claim.rounds}` : '';

  const lines = [
    claimMarker(claim.id),
    `### ${claim.id} · ${claim.severity} · ${claim.state}${round}`,
    '',
    `\`${claim.raisedBy}\` → ${against} on \`${claim.target}\``,
    '',
    claim.assertion,
    '',
    `**Falsifier.** ${claim.falsifier}`,
    '',
    '**Evidence**',
    '',
    ...renderEvidence(claim.evidence),
  ];

  // Only a settled claim states an outcome. An open claim rendered with a
  // resolution would publish a verdict the protocol has not reached.
  if (claim.state === 'resolved' && claim.resolution !== undefined) {
    lines.push('', `**Resolution.** ${claim.resolution}.`);
  }

  // The deciding decision, when the argument needed one. Rendered only where it
  // exists: a section on every claim would publish an ordinary concession as an
  // adjudication, and an open decision must not be given an outcome it has not
  // reached.
  if (decision !== undefined) {
    const verdict = decision.outcome === undefined ? '_undecided_' : `**${decision.outcome}**`;
    lines.push('', `**Decided by** ${decision.id} (${decision.method}) — ${verdict}`, '', `> ${decision.question}`);
  }

  return lines.join('\n');
}

export function findMarkedComment(
  comments: readonly MirrorComment[],
  marker: string,
): MirrorComment | undefined {
  return comments.find((comment) => comment.body.includes(marker));
}
