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
