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
): ParticipantId | undefined {
  const claim = state.claims.get(claimId);
  if (claim === undefined) return undefined;

  const responder = responderFor(claim, state);
  const candidates = config.participants
    .filter((p) => p.role === 'worker' && p.id !== claim.raisedBy && p.id !== responder)
    .map((p) => p.id);

  return candidates.find((id) => state.participants.has(id)) ?? candidates[0];
}

/**
 * The next rung that can actually be attempted, from the *live* rung.
 *
 * `undefined` means the ladder is at its last rung, which is terminal by
 * validation — falling off the end is a bug, not a state.
 */
export function nextRung(
  decision: Decision,
  config: CrosstalkConfig,
  state: HubState,
): { rung: LadderRung; index: number } | undefined {
  const ladder = decision.ladder;
  if (ladder === undefined) return undefined;

  const current = currentRungOf(decision, state);
  for (let index = (current?.index ?? -1) + 1; index < ladder.length; index += 1) {
    const rung = ladder[index]!;
    if (attemptable(rung, decision, config, state)) return { rung, index };
  }
  return undefined;
}

function attemptable(
  rung: LadderRung,
  decision: Decision,
  config: CrosstalkConfig,
  state: HubState,
): boolean {
  if (rung !== 'third_agent') return true;
  return (
    decision.claimId !== undefined && adjudicatorFor(decision.claimId, config, state) !== undefined
  );
}
