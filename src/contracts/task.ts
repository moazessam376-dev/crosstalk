import type { ParticipantId } from './participant.js';
import type { Evidence } from './claim.js';

export type TaskState =
  | 'draft'
  | 'assigned'
  | 'acknowledged'
  | 'in_progress'
  | 'self_reviewed'
  | 'submitted'
  | 'under_review'
  | 'resolving'
  | 'accepted'
  | 'merged';

export interface CritiqueFinding {
  assertion: string;
  closedBy: Evidence[];
  /** Set when the assignee disagreed with its own critic, with the reason. */
  rejected?: string;
}

/** Gate 2. Shape is defined here; how the critique was run is not. */
export interface CritiqueRecord {
  rounds: number;
  /** An empty array is legal, and visible in the ledger. */
  findings: CritiqueFinding[];
  /** Free text: how the critique was run. */
  critic: string;
}

/** Gate 1. The cheapest place to catch a brief that contradicts itself. */
export interface Acknowledgement {
  restatement: string;
  ambiguities: string[];
}

export interface Task {
  /** "T-04" */
  id: string;
  title: string;
  brief: string;
  specRefs: string[];
  assignee: ParticipantId;
  deps: string[];
  /** Required, and each item must be independently checkable. */
  acceptance: string[];
  state: TaskState;
  /** "ct/T-04-slug" */
  branch: string;
  pr?: number;
  acknowledgement?: Acknowledgement;
  critique?: CritiqueRecord;
}
