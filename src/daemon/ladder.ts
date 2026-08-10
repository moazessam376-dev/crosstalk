import type { CrosstalkConfig } from '../contracts/config.js';
import type { Decision } from '../contracts/decision.js';
import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import { adjudicatorFor, planLadder } from '../core/ladder.js';
import type { HubState } from '../core/projection.js';

/** The slice of the handler context the ladder needs. */
export interface LadderContext {
  who: ParticipantId;
  config: CrosstalkConfig;
  state: HubState;
  append(draft: DraftEvent): Promise<CrosstalkEvent>;
}

/**
 * Every participant who could be asked at any rung — freeze rule 3.
 *
 * Read from `config`, not from the joined participants: a worker that has not
 * polled yet is still someone the ladder may have to summon, and `await_turn`
 * is how it finds out. Deciding a dispute's shape from who happens to be
 * connected at the moment it escalates would make the ladder depend on timing.
 */
export function ladderVoters(config: CrosstalkConfig): ParticipantId[] {
  return [...new Set([...config.participants.map((p) => p.id), HUMAN_ID])];
}

/**
 * Open a ladder for a dispute that has run past `maxRounds`, if one is not
 * already running.
 *
 * The guard is not optional. A1 makes responses past the maximum the *expected*
 * case rather than the edge case, so without it response 4 opens `D-1`,
 * response 5 opens `D-2`, and each arms its own timers racing the others.
 */
export async function escalateIfNeeded(
  ctx: LadderContext,
  claimId: string,
): Promise<CrosstalkEvent[]> {
  const claim = ctx.state.claims.get(claimId);
  if (claim === undefined || claim.state !== 'contested') return [];
  if (claim.rounds <= ctx.config.policy.dispute.maxRounds) return [];
  if (hasUnresolvedLadder(claimId, ctx.state)) return [];

  const plan = planLadder(ctx.config.policy.dispute.ladder, ctx.config);
  const room = `dispute:${claimId}`;
  const decision: Decision = {
    id: `D-${ctx.state.decisions.size + 1}`,
    question: `Settle claim ${claimId}`,
    options: ['uphold', 'withdraw'],
    voters: ladderVoters(ctx.config),
    method: 'ladder',
    ladder: plan.ladder,
    // The open-time snapshot. It never moves; the live rung is the last
    // `rung_entered`.
    currentRung: plan.start,
    skipped: plan.skipped,
    rationale: [],
    votes: {},
    claimId,
  };

  const events = [await ctx.append({ kind: 'decision_opened', from: ctx.who, room, decision })];
  events.push(...(await enterRung(ctx, decision, plan.start)));
  return events;
}

/**
 * Emit `rung_entered` for `index`, naming the adjudicator when the rung has
 * one. Chosen here rather than at open time because "uninvolved" decays.
 */
export async function enterRung(
  ctx: LadderContext,
  decision: Decision,
  index: number,
): Promise<CrosstalkEvent[]> {
  const rung = decision.ladder?.[index];
  if (rung === undefined) return [];

  const adjudicator =
    rung === 'third_agent' && decision.claimId !== undefined
      ? adjudicatorFor(decision.claimId, ctx.config, ctx.state)
      : undefined;

  return [
    await ctx.append({
      kind: 'rung_entered',
      from: ctx.who,
      room: decision.claimId === undefined ? '#floor' : `dispute:${decision.claimId}`,
      decisionId: decision.id,
      rung,
      index,
      ...(adjudicator === undefined ? {} : { adjudicator }),
    }),
  ];
}

function hasUnresolvedLadder(claimId: string, state: HubState): boolean {
  for (const decision of state.decisions.values()) {
    if (decision.claimId === claimId && decision.method === 'ladder' && decision.outcome === undefined) {
      return true;
    }
  }
  return false;
}
