import type { Claim, Evidence } from '../contracts/claim.js';
import type { Decision, LadderRung } from '../contracts/decision.js';
import type { ParticipantId } from '../contracts/participant.js';

/**
 * A ladder's history, which `HubState` does not keep.
 *
 * The projection retains only the *live* rung (`HubState.rungs`), and discards
 * `test_proposed` and `rung_failed` outright — correctly, since the hub renders
 * from the live position. The published record needs the climb itself, so the
 * mirror accumulates it off the stream.
 */
export interface LadderHistory {
  entered: { rung: LadderRung; index: number; adjudicator?: ParticipantId }[];
  failed: { rung: LadderRung; index: number; reason: string }[];
  tests: { command: string; predicts: string; sha: string }[];
  /**
   * Freeze rule 1: the index of the last `rung_entered`, falling back to
   * `Decision.currentRung ?? 0`. Supplied by the caller from Track A's
   * `HubState.rungs` rather than recomputed here — two consumers disagreeing
   * about which rung is current is the divergence C-18 exists to close.
   */
  current: number;
}

export interface MirrorComment {
  /** GitHub's own field, present on reads and unused on writes. */
  authorAssociation?: string;
  /** The author's login, present on reads. */
  authorLogin?: string;
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
export function renderClaimComment(
  claim: Claim,
  decision?: Decision,
  ladder?: LadderHistory,
): string {
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
    lines.push(...renderLadder(decision, ladder));
  }

  return lines.join('\n');
}

/**
 * The climb, or nothing.
 *
 * Nothing is the important half: a ladder section printed unconditionally would
 * make a dispute settled in one exchange look like one that escalated, which is
 * the flattening this exists to remove, pointing the other way.
 */
function renderLadder(decision: Decision, ladder?: LadderHistory): string[] {
  const skipped = decision.skipped ?? [];
  if (ladder === undefined && skipped.length === 0) return [];
  if (ladder !== undefined && ladder.entered.length === 0 && skipped.length === 0) return [];

  const lines = ['', '**Ladder**', ''];

  for (const entry of ladder?.entered ?? []) {
    // Matched on `index`, never on the rung's name: a ladder may enter the same
    // rung twice, and a rung can fail at entry without one. The position is the
    // fact; pairing by name was a rule nothing enforced.
    const failure = ladder?.failed.find((candidate) => candidate.index === entry.index);
    const adjudicator = entry.adjudicator === undefined ? '' : ` — adjudicator \`${entry.adjudicator}\``;
    const failed = failure === undefined ? '' : ` — **failed**: ${failure.reason}`;
    const here = ladder !== undefined && entry.index === ladder.current ? ' ← current' : '';
    lines.push(`- \`${entry.index}\` ${entry.rung}${adjudicator}${failed}${here}`);
  }

  // Audit F-07: a degraded ladder must not read as a short one. `SkippedRung`
  // carries no index, so these are listed as themselves rather than given a
  // position they were never assigned.
  for (const skip of skipped) {
    lines.push(`- ~~${skip.rung}~~ — skipped: ${skip.reason}`);
  }

  for (const test of ladder?.tests ?? []) {
    lines.push(
      '',
      `**Discriminating test proposed** — \`${test.command}\` at \`${test.sha}\``,
      '',
      `> predicts: ${test.predicts}`,
    );
  }

  return lines;
}

export function findMarkedComment(
  comments: readonly MirrorComment[],
  marker: string,
): MirrorComment | undefined {
  return comments.find((comment) => comment.body.includes(marker));
}
