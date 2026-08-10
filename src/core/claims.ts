import type { Claim, ClaimVerdict, Evidence, Severity } from '../contracts/claim.js';
import { ProtocolError } from '../contracts/errors.js';
import type { ParticipantId } from '../contracts/participant.js';
import type { HubState } from './projection.js';

export interface RaiseClaimInput {
  raisedBy: ParticipantId;
  against: Claim['against'];
  target: string;
  assertion: string;
  severity: Severity;
  falsifier: string;
  evidence: Evidence[];
  taskId?: string;
}

export interface ClaimResponseInput {
  claimId: string;
  from: ParticipantId;
  verdict: ClaimVerdict;
  rationale?: string;
  falsifier?: string;
  evidence: Evidence[];
}

export const VACUITY_PATTERNS = [
  /^(if )?(it|this|that) (did ?n[o']?t|does ?n[o']?t|would ?n[o']?t) work/i,
] as const;


export function validateRaise(input: RaiseClaimInput, state: HubState): Claim {
  validateFalsifier(input.falsifier, input.assertion);

  return {
    id: nextClaimId(state),
    raisedBy: input.raisedBy,
    against: input.against,
    target: input.target,
    assertion: input.assertion,
    severity: input.severity,
    falsifier: input.falsifier.trim(),
    evidence: [...input.evidence],
    state: 'open',
    rounds: 0,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  };
}

export function validateResponse(input: ClaimResponseInput, state: HubState): void {
  const claim = state.claims.get(input.claimId);
  if (!claim) {
    throw new ProtocolError('UNKNOWN_CLAIM', `Unknown claim: ${input.claimId}`);
  }

  validateResponseAuthority(input, claim, state);

  switch (input.verdict) {
    case 'contest':
      requireText(input.rationale, 'CONTEST_WITHOUT_RATIONALE', 'contest requires a rationale');
      validateFalsifier(input.falsifier ?? '', claim.assertion);
      requireEvidence(input.evidence, 'CONTEST_WITHOUT_COUNTER_EVIDENCE', 'contest requires counter-evidence');
      return;
    case 'uphold':
      if (!input.evidence.some((evidence) => isNewEvidence(evidence, claim.evidence))) {
        throw new ProtocolError('UPHOLD_WITHOUT_NEW_EVIDENCE', 'uphold requires new evidence');
      }
      return;
    case 'accept':
      requireEvidence(input.evidence, 'CONTEST_WITHOUT_COUNTER_EVIDENCE', 'accept requires fix evidence');
      return;
    case 'clarify':
      requireText(input.rationale, 'CONTEST_WITHOUT_RATIONALE', 'clarify requires the ambiguity to route');
      return;
    case 'concede':
      requireText(input.rationale, 'CONTEST_WITHOUT_RATIONALE', 'concede requires rationale for the ledger');
      return;
    case 'amend':
      requireText(input.rationale, 'CONTEST_WITHOUT_RATIONALE', 'amend requires rationale');
      validateFalsifier(input.falsifier ?? '', claim.assertion);
      requireEvidence(input.evidence, 'CONTEST_WITHOUT_COUNTER_EVIDENCE', 'amend requires evidence for the replacement claim');
      return;
  }

  throw new Error(`Unknown claim verdict: ${input.verdict satisfies never}`);
}

function validateResponseAuthority(input: ClaimResponseInput, claim: Claim, state: HubState): void {
  if (claim.state === 'open') {
    if (input.verdict !== 'accept' && input.verdict !== 'contest' && input.verdict !== 'clarify') {
      throw new ProtocolError(
        'ILLEGAL_CLAIM_RESPONSE',
        'Claim ' + claim.id + ' is open and cannot accept a ' + input.verdict + ' response',
      );
    }

    const expectedResponder = responderFor(claim, state);
    if (input.from !== expectedResponder) {
      throw new ProtocolError(
        'NOT_CLAIM_RESPONDER',
        'Participant ' + input.from + ' is not authorized to respond to claim ' + claim.id,
      );
    }
    return;
  }

  if (claim.state === 'contested') {
    // A dispute alternates. Whoever answered last does not answer again, or an
    // `uphold` returns the claim to a state only the raiser can leave and the
    // participant being upheld against gets exactly one turn in the argument.
    const respondersTurn = claim.lastResponder !== undefined && claim.lastResponder === claim.raisedBy;
    const eligible = respondersTurn ? responderFor(claim, state) : claim.raisedBy;
    const verdicts = respondersTurn ? TRIAGE_VERDICTS : CONTEST_VERDICTS;

    // Authority before legality: answering out of turn is `NOT_CLAIM_RESPONDER`
    // whatever verdict it carries. Reporting the verdict as illegal would tell
    // the wrong participant to try a different one.
    if (input.from !== eligible) {
      throw new ProtocolError(
        'NOT_CLAIM_RESPONDER',
        'Participant ' + input.from + ' is not authorized to respond to claim ' + claim.id +
          '; it is ' + eligible + "'s turn",
      );
    }
    if (!(verdicts as readonly ClaimVerdict[]).includes(input.verdict)) {
      throw new ProtocolError(
        'ILLEGAL_CLAIM_RESPONSE',
        'Claim ' + claim.id + ' is contested and cannot accept a ' + input.verdict + ' response',
      );
    }
    return;
  }

  if (claim.state === 'clarify') {
    const isOwnerAcceptance = input.from === briefOwner(state) && input.verdict === 'accept';
    const isClaimantResolution =
      input.from === claim.raisedBy && (input.verdict === 'concede' || input.verdict === 'amend');

    if (isOwnerAcceptance || isClaimantResolution) {
      return;
    }

    throw new ProtocolError(
      'NOT_CLAIM_RESPONDER',
      'Participant ' + input.from + ' is not authorized to resolve clarified claim ' + claim.id,
    );
  }

  throw new ProtocolError(
    'ILLEGAL_CLAIM_RESPONSE',
    'Claim ' + claim.id + ' is ' + claim.state + ' and cannot receive responses',
  );
}

/** How the target of a claim answers it. */
const TRIAGE_VERDICTS = ['accept', 'contest', 'clarify'] as const;
/** How the raiser answers a contest. */
const CONTEST_VERDICTS = ['concede', 'amend', 'uphold'] as const;

/**
 * Who is expected to answer this claim.
 *
 * Never compare against `claim.against` directly: for a `brief`/`spec` claim it
 * is a literal, not a participant, so the comparison matches nobody and the
 * alternation falls through undefined. That is the claim shape this project's
 * own plan reviews use.
 */
export function responderFor(claim: Claim, state: HubState): ParticipantId {
  return claim.against === 'brief' || claim.against === 'spec' ? briefOwner(state) : claim.against;
}

function briefOwner(state: HubState): ParticipantId {
  for (const [id, participant] of state.participants) {
    if (participant.role === 'leader') {
      return id;
    }
  }
  return 'leader';
}

function validateFalsifier(falsifier: string, assertion: string): void {
  const trimmed = falsifier.trim();
  if (!trimmed) {
    throw new ProtocolError('MISSING_FALSIFIER', 'claim requires a falsifier');
  }

  if (isVacuousFalsifier(trimmed, assertion)) {
    throw new ProtocolError('VACUOUS_FALSIFIER', 'falsifier must describe a discriminating observation');
  }
}

function isVacuousFalsifier(falsifier: string, assertion: string): boolean {
  return (
    falsifier.length < 20 ||
    VACUITY_PATTERNS.some((pattern) => pattern.test(falsifier)) ||
    normalize(falsifier) === normalize(assertion)
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\W+/g, ' ').trim();
}

function requireText(
  value: string | undefined,
  code: 'CONTEST_WITHOUT_RATIONALE',
  message: string,
): void {
  if (value === undefined || value.trim() === '') {
    throw new ProtocolError(code, message);
  }
}

function requireEvidence(
  evidence: Evidence[],
  code: 'CONTEST_WITHOUT_COUNTER_EVIDENCE',
  message: string,
): void {
  if (evidence.length === 0) {
    throw new ProtocolError(code, message);
  }
}

function isNewEvidence(candidate: Evidence, existing: Evidence[]): boolean {
  return existing.every((evidence) => evidence.sha !== candidate.sha || evidence.command !== candidate.command);
}

function nextClaimId(state: HubState): string {
  return `C-${state.claims.size + 1}`;
}
