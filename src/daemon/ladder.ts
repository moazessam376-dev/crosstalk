import type { CrosstalkConfig } from '../contracts/config.js';
import type { Decision } from '../contracts/decision.js';
import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import { FLOOR, HUMAN_ID, SYSTEM_ID } from '../contracts/room.js';

// Re-exported so `server.ts` keeps one import site; the id itself is a contract.
export { SYSTEM_ID };
import { adjudicatorFor, nextRung, planLadder } from '../core/ladder.js';
import { responderFor } from '../core/claims.js';
import { currentRungOf } from '../core/decisions.js';
import type { HubState } from '../core/projection.js';

/** The slice of the handler context the ladder needs. */
export interface LadderContext {
  who: ParticipantId;
  config: CrosstalkConfig;
  state: HubState;
  /**
   * When each participant was last heard from. The `third_agent` rung ranks by
   * this rather than by "has ever presented a token", so a peer probed once
   * from a human shell cannot outrank one that has been answering.
   */
  seenAt?: ReadonlyMap<ParticipantId, number>;
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
      ? adjudicatorFor(decision.claimId, ctx.config, ctx.state, ctx.seenAt)
      : undefined;

  const room = decision.claimId === undefined ? FLOOR : `dispute:${decision.claimId}`;
  const events: CrosstalkEvent[] = [
    await ctx.append({
      kind: 'rung_entered',
      from: ctx.who,
      room,
      decisionId: decision.id,
      rung,
      index,
      ...(adjudicator === undefined ? {} : { adjudicator }),
    }),
  ];

  // A rung nobody can answer is entered and then failed, never skipped in
  // silence: the log has to show it was tried. `planLadder` already removed
  // the rungs this project can never run; this is the one that could, today,
  // if a peer were free.
  if (rung === 'third_agent' && adjudicator === undefined) {
    events.push(...(await expireRung(ctx, decision.id, 'no_uninvolved_peer')));
  }
  return events;
}

/**
 * A claim that has been settled stops its ladder.
 *
 * The ordinary end of an escalated dispute is `concede`, `accept` or `amend` —
 * none of which touch the decision. Without this the timer stays armed and
 * later fires `rung_entered` on an argument that ended hours ago, and with
 * `human` on the ladder that pages a person about a settled dispute.
 *
 * A claim reopened later by staleness does not revive this decision; a fresh
 * escalation opens a new one.
 */
export async function closeLadderIfResolved(
  ctx: LadderContext,
  claimId: string,
): Promise<CrosstalkEvent[]> {
  const claim = ctx.state.claims.get(claimId);
  if (claim === undefined || claim.state !== 'resolved') return [];

  const events: CrosstalkEvent[] = [];
  for (const decision of ctx.state.decisions.values()) {
    if (decision.claimId !== claimId || decision.method !== 'ladder') continue;
    if (decision.outcome !== undefined) continue;

    events.push(
      await ctx.append({
        kind: 'decision_resolved',
        from: ctx.who,
        room: `dispute:${claimId}`,
        decisionId: decision.id,
        outcome: 'claim_resolved',
      }),
    );
  }
  return events;
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

  const next = nextRung(decision, ctx.state);
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
  /** Who has proposed a discriminating test, by decision. */
  readonly #proposals = new Map<string, Set<ParticipantId>>();
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
    if (event.kind === 'test_proposed') {
      const seen = this.#proposals.get(event.decisionId) ?? new Set<ParticipantId>();
      seen.add(event.from);
      this.#proposals.set(event.decisionId, seen);
      return;
    }
    // A settled decision stops counting. Otherwise a dispute that ended hours
    // ago fires `rung_entered` on a settled argument, and with `human` on the
    // ladder that pages a person at 4am.
    if (event.kind === 'decision_resolved') this.disarm(event.decisionId);
  }

  proposalsFor(decisionId: string): ReadonlySet<ParticipantId> {
    return this.#proposals.get(decisionId) ?? new Set();
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
      if (event.kind === 'test_proposed') {
        const seen = this.#proposals.get(event.decisionId) ?? new Set<ParticipantId>();
        seen.add(event.from);
        this.#proposals.set(event.decisionId, seen);
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


/**
 * Why a `discriminating_test` rung failed.
 *
 * Fewer than two proposals names who was silent, because §12 counts falsifiers
 * that failed to yield a test *per participant* — "inconclusive" against both
 * would charge the side that did produce one. Two or more with the claim still
 * unresolved is genuinely inconclusive.
 */
export function testRungReason(
  proposed: ReadonlySet<ParticipantId>,
  decision: Decision,
  state: HubState,
): string {
  const claim = decision.claimId === undefined ? undefined : state.claims.get(decision.claimId);
  if (claim === undefined) return 'test_inconclusive';

  const silent = [claim.raisedBy, responderFor(claim, state)].filter((who) => !proposed.has(who));
  return silent.length === 0 ? 'test_inconclusive' : `no_test_from:${silent.join(',')}`;
}
