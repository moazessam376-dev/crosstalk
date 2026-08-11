import type { CrosstalkConfig } from '../contracts/config.js';
import type { Decision, LadderRung, SkippedRung } from '../contracts/decision.js';
import type { ParticipantId } from '../contracts/participant.js';
import { responderFor } from './claims.js';
import { currentRungOf } from './decisions.js';
import type { HubState } from './projection.js';

export interface LadderPlan {
  /** The configured ladder, unfiltered — the rail renders every rung. */
  ladder: LadderRung[];
  /** Rungs that will not be attempted, each with a reason. */
  skipped: SkippedRung[];
  /** Index into `ladder` of the first attemptable rung. */
  start: number;
}

/**
 * Could each rung of this ladder *ever* run on this project? Asked once, at
 * open, from the configuration.
 *
 * Deliberately not from `HubState`: its `participants` map is projected from
 * `participant_joined`, so it counts who has connected. `skipped` is frozen
 * into `decision_opened` on an append-only log, so planning from connections
 * would let an escalation that fired while a worker happened to be offline
 * permanently lose its `third_agent` rung — and record a reason blaming a
 * configuration that was never at fault. Agents attaching at different times
 * is what `lifecycle: attached` means.
 *
 * Whether a peer is reachable *right now* is `adjudicatorFor`'s question,
 * asked again at every rung entry.
 */
export function planLadder(ladder: LadderRung[], config: CrosstalkConfig): LadderPlan {
  const workers = config.participants.filter((p) => p.role === 'worker').length;
  const skipped: SkippedRung[] = [];

  for (const rung of ladder) {
    if (rung === 'third_agent' && workers < 2) {
      skipped.push({
        rung,
        reason: `only ${workers} worker configured; third_agent needs an uninvolved peer`,
      });
    }
  }

  const start = ladder.findIndex((rung) => !skipped.some((entry) => entry.rung === rung));
  return { ladder: [...ladder], skipped, start: start === -1 ? ladder.length : start };
}

/**
 * Who can rule at `third_agent` right now.
 *
 * Re-evaluated at every rung entry rather than chosen when the ladder opens:
 * "uninvolved" decays, and the peer picked at open may hold its own claim by
 * the time rung 2 is reached.
 *
 * Candidates come from the configuration, so a worker that has not polled yet
 * is still nameable — `await_turn` is how it finds out. A connected peer is
 * preferred where one exists, because it can answer sooner and has been
 * reading the argument.
 */
export function adjudicatorFor(
  claimId: string,
  config: CrosstalkConfig,
  state: HubState,
  seenAt: ReadonlyMap<ParticipantId, number> = new Map(),
): ParticipantId | undefined {
  const claim = state.claims.get(claimId);
  if (claim === undefined) return undefined;

  const responder = responderFor(claim, state);
  const candidates = config.participants
    .filter((p) => p.role === 'worker' && p.id !== claim.raisedBy && p.id !== responder)
    .map((p) => p.id);

  // Ranked by *when* a peer was last heard from, not by whether it ever was.
  //
  // `state.participants` is projected from `participant_joined`, which the
  // daemon stamps the first time a token is presented and nothing ever
  // retracts. So it means "has spoken at least once, ever" — and one read-only
  // `roster` call from a human shell was enough to make a never-started agent
  // outrank a peer that had been answering all along. The rung was then
  // entered, assigned to somebody absent, and timed out instead of going to
  // the peer that could have ruled.
  //
  // Falling back to joined-ness rather than straight to configuration order
  // keeps the weaker signal where it is the only one available: on a daemon
  // that has just started, "has connected at all" still beats "is merely
  // configured". `sort` is stable, so configuration order breaks the tie.
  const rank = (id: ParticipantId): number =>
    seenAt.get(id) ?? (state.participants.has(id) ? 0 : -1);

  return [...candidates].sort((a, b) => rank(b) - rank(a))[0];
}

/**
 * The rung after the live one.
 *
 * Deliberately does *not* filter on whether a peer is available: a rung that
 * cannot run is entered and then failed with a reason, so the ladder shows it
 * was tried. Skipping it here would make an unavailable `third_agent`
 * indistinguishable from a ladder that never had one — the silence audit F-07
 * exists to prevent.
 *
 * `undefined` means the ladder is at its last rung, which is terminal by
 * validation — falling off the end is a bug, not a state.
 */
export function nextRung(
  decision: Decision,
  state: HubState,
): { rung: LadderRung; index: number } | undefined {
  const ladder = decision.ladder;
  if (ladder === undefined) return undefined;

  const index = (currentRungOf(decision, state)?.index ?? -1) + 1;
  const rung = ladder[index];
  return rung === undefined ? undefined : { rung, index };
}
