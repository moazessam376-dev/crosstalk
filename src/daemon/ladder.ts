import type { CrosstalkConfig } from '../contracts/config.js';
import type { Decision } from '../contracts/decision.js';
import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import { FLOOR } from '../contracts/room.js';
import { adjudicatorFor, nextRung, planLadder } from '../core/ladder.js';
import { currentRungOf } from '../core/decisions.js';
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

/* ---------------------------------------------------------------- timers -- */

/**
 * Author of daemon-driven events — a rung that expired because nobody acted.
 *
 * A reserved id nobody holds, mirroring `@human`. It matters that it is not a
 * real participant: `addressesParticipant` returns false when `from === who`,
 * so attributing a timeout to the leader would be exactly the participant the
 * next rung most needs to wake.
 */
export const SYSTEM_ID: ParticipantId = '@crosstalk';

const DURATION = /^(\d+)\s*(s|m|h)$/i;

/** `"30m"`, `"4h"`, `"90s"`. Undefined for anything unparseable. */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = DURATION.exec(value.trim());
  if (match === null) return undefined;

  const amount = Number(match[1]);
  switch (match[2]!.toLowerCase()) {
    case 's':
      return amount * 1_000;
    case 'm':
      return amount * 60_000;
    default:
      return amount * 3_600_000;
  }
}

/**
 * How long this rung waits, or `undefined` when it must never be armed.
 *
 * The last rung never arms one whatever `rungTimeouts` says: §5.3's terminal
 * rung blocks indefinitely by design, and a timer there would advance past the
 * end of the ladder — which is a bug, not a state. A non-final rung with no
 * configured timeout blocks too, rather than becoming `setTimeout(NaN)`.
 */
export function rungTimeoutMs(
  decision: Decision,
  index: number,
  config: CrosstalkConfig,
): number | undefined {
  const ladder = decision.ladder;
  if (ladder === undefined || index >= ladder.length - 1) return undefined;
  return parseDuration(config.policy.dispute.rungTimeouts[ladder[index]!]);
}

/**
 * A rung ran out of time: record the failure and climb.
 *
 * `rung_failed` carries the index rather than only the name, so a ladder that
 * visits a rung twice still pairs unambiguously to a rail position.
 */
export async function expireRung(
  ctx: LadderContext,
  decisionId: string,
  reason: string,
): Promise<CrosstalkEvent[]> {
  const decision = ctx.state.decisions.get(decisionId);
  if (decision === undefined || decision.outcome !== undefined) return [];

  const current = currentRungOf(decision, ctx.state);
  if (current === undefined) return [];

  const room = decision.claimId === undefined ? FLOOR : `dispute:${decision.claimId}`;
  const events = [
    await ctx.append({
      kind: 'rung_failed',
      from: ctx.who,
      room,
      decisionId,
      rung: current.rung,
      index: current.index,
      reason,
    }),
  ];

  const next = nextRung(decision, ctx.config, ctx.state);
  if (next !== undefined) events.push(...(await enterRung(ctx, decision, next.index)));
  return events;
}

/**
 * Arms and disarms rung timers by watching the log.
 *
 * Driven by appended events rather than called from each site: every path that
 * enters a rung appends `rung_entered`, so there is one place to get this right
 * instead of one per caller.
 */
export class LadderTimers {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #fire: (decisionId: string, reason: string) => void;

  constructor(fire: (decisionId: string, reason: string) => void) {
    this.#fire = fire;
  }

  observe(event: CrosstalkEvent, state: HubState, config: CrosstalkConfig): void {
    if (event.kind === 'rung_entered') {
      const decision = state.decisions.get(event.decisionId);
      if (decision === undefined) return;
      this.#set(event.decisionId, rungTimeoutMs(decision, event.index, config));
      return;
    }
    // A settled decision stops counting. Otherwise a dispute that ended hours
    // ago fires `rung_entered` on a settled argument, and with `human` on the
    // ladder that pages a person at 4am.
    if (event.kind === 'decision_resolved') this.disarm(event.decisionId);
  }

  /**
   * Re-arm after a restart, from the last `rung_entered` for each decision.
   * A deadline that has already passed fires at once rather than being lost.
   */
  rearm(log: readonly CrosstalkEvent[], state: HubState, config: CrosstalkConfig, now: number): void {
    const entered = new Map<string, { index: number; at: number }>();
    for (const event of [...log].sort((a, b) => a.seq - b.seq)) {
      if (event.kind === 'rung_entered') {
        entered.set(event.decisionId, { index: event.index, at: Date.parse(event.ts) });
      }
    }

    for (const [decisionId, last] of entered) {
      const decision = state.decisions.get(decisionId);
      if (decision === undefined || decision.outcome !== undefined) continue;

      const budget = rungTimeoutMs(decision, last.index, config);
      if (budget === undefined) continue;
      // Wall-clock is correct here and is not a rule-4 violation: rule 4 is
      // about *ordering*, and §5.3 gives rung timeouts in minutes and hours.
      this.#set(decisionId, Math.max(0, last.at + budget - now));
    }
  }

  disarm(decisionId: string): void {
    const timer = this.#timers.get(decisionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(decisionId);
    }
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #set(decisionId: string, ms: number | undefined): void {
    this.disarm(decisionId);
    if (ms === undefined) return;

    const timer = setTimeout(() => {
      this.#timers.delete(decisionId);
      this.#fire(decisionId, 'timeout');
    }, ms);
    // A pending rung must not hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
    this.#timers.set(decisionId, timer);
  }
}
