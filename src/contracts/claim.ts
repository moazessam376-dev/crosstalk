import type { ParticipantId } from './participant.js';

export type Severity = 'blocker' | 'defect' | 'risk' | 'nit';

export type ClaimState = 'open' | 'triaged' | 'contested' | 'clarify' | 'resolved';

export type ClaimResolution = 'upheld' | 'withdrawn' | 'amended' | 'superseded';

/** How the target of a claim answers it. */
export type TriageVerdict = 'accept' | 'contest' | 'clarify';

/** How the raiser of a claim answers a contest. */
export type ContestVerdict = 'concede' | 'amend' | 'uphold';

export type ClaimVerdict = TriageVerdict | ContestVerdict;

export interface Evidence {
  kind: 'command' | 'file' | 'observation';
  command?: string;
  /** Truncated for transport; the full artifact lives on disk. */
  output?: string;
  /** `path:line` for `kind: "file"`. */
  ref?: string;
  /** The commit this was gathered at. Evidence without a sha is unverifiable. */
  sha: string;
  by: ParticipantId;
  /** Set when `sha` is no longer an ancestor of HEAD. Derived, never authored. */
  stale?: boolean;
}

export interface Claim {
  /** "C-118" */
  id: string;
  raisedBy: ParticipantId;
  /** A participant, or the brief/spec itself — claims run in every direction. */
  against: ParticipantId | 'brief' | 'spec';
  /** "src/economy.ts:41" | "test:siege" | "brief:T-04#3" */
  target: string;
  assertion: string;
  severity: Severity;
  /**
   * What the author would expect to observe if this claim were wrong.
   * Required. A claim that cannot be refuted cannot be settled.
   */
  falsifier: string;
  evidence: Evidence[];
  state: ClaimState;
  resolution?: ClaimResolution;
  /** Incremented on every response. Compared against `policy.dispute.maxRounds`. */
  rounds: number;
  /**
   * Who answered last. A dispute alternates: the target answers the raiser,
   * the raiser answers the target.
   *
   * Without this the validator could only ask "is this the raiser?", so an
   * `uphold` returned the claim to `contested` — a state only the raiser could
   * leave. The participant being upheld against got exactly one turn in the
   * argument, which is the hierarchy this project exists to remove.
   *
   * Compared against `responderFor(claim, state)`, never against
   * `claim.against` directly: for a `brief`/`spec` claim there is no
   * participant of that name and the comparison would match nobody.
   *
   * Derived by the projection, never authored.
   */
  lastResponder?: ParticipantId;
  taskId?: string;
  /** Set on an amended claim, naming the claim it replaces. */
  supersedes?: string;
}
