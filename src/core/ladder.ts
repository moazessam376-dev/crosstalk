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
 * The ladder as it will actually be walked, decided when the dispute escalates.
 *
 * Rungs are recorded as skipped rather than filtered out: a ladder degraded
 * because there was no uninvolved peer to call must not look like a ladder
 * somebody deliberately configured short. Audit F-07.
 */
export function planLadder(ladder: LadderRung[], state: HubState): LadderPlan {
  const workers = [...state.participants.values()].filter((p) => p.role === 'worker').length;
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
 * An uninvolved peer to rule at `third_agent`.
 *
 * Re-evaluated at every rung entry rather than chosen when the ladder opens:
 * "uninvolved" decays, and the peer picked at open may hold its own claim by
 * the time rung 2 is reached.
 *
 * The responder is resolved through `responderFor`, so a `brief`/`spec` claim
 * excludes the brief owner rather than the literal string.
 */
export function adjudicatorFor(claimId: string, state: HubState): ParticipantId | undefined {
  const claim = state.claims.get(claimId);
  if (claim === undefined) return undefined;

  const responder = responderFor(claim, state);
  for (const [id, participant] of state.participants) {
    if (participant.role !== 'worker') continue;
    if (id === claim.raisedBy || id === responder) continue;
    return id;
  }
  return undefined;
}

/**
 * The next rung that can actually be attempted, from the *live* rung.
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

  const current = currentRungOf(decision, state);
  for (let index = (current?.index ?? -1) + 1; index < ladder.length; index += 1) {
    const rung = ladder[index]!;
    if (attemptable(rung, decision, state)) return { rung, index };
  }
  return undefined;
}

function attemptable(rung: LadderRung, decision: Decision, state: HubState): boolean {
  if (rung !== 'third_agent') return true;
  return decision.claimId !== undefined && adjudicatorFor(decision.claimId, state) !== undefined;
}
