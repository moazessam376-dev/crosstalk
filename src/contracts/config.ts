import type { Participant } from './participant.js';
import type { DecisionMethod, LadderRung } from './decision.js';

export interface ProjectConfig {
  /** Repo root, relative to the config file. */
  repo: string;
  mainBranch: string;
}

/** Durations are `"30m"`, `"4h"` — parsed by the consumer, not the contract. */
export type Duration = string;

/** How a plan is formed before it is frozen. See spec §5.6. */
export type PlanningMode = 'solo' | 'review' | 'panel';

export interface PolicyConfig {
  /**
   * Optional: absent means `DEFAULT_POLICY.planning`. Optional rather than
   * required because no v1 code reads it yet, and a forward-looking field
   * should not invalidate configs that predate it.
   */
  planning?: {
    mode: PlanningMode;
    /** `review`: independent readers. `panel`: independent drafters. Ignored for `solo`. */
    agents: number;
    /** How `panel` selects among drafts. Ignored otherwise. */
    selection: DecisionMethod;
  };
  selfCritique: {
    required: boolean;
    minRounds: number;
  };
  leaderCritique: {
    maxRounds: number;
  };
  dispute: {
    maxRounds: number;
    /** Must end on a rung in TERMINAL_RUNGS. */
    ladder: LadderRung[];
    rungTimeouts: Partial<Record<LadderRung, Duration>>;
  };
  taskAcceptance: {
    method: DecisionMethod;
  };
}

export type MirrorMode = 'off' | 'one-way' | 'two-way-human';

export interface MirrorConfig {
  github: {
    enabled: boolean;
    mode: MirrorMode;
    pollSeconds: number;
  };
}

export interface CrosstalkConfig {
  version: 1;
  project: ProjectConfig;
  participants: Participant[];
  policy: PolicyConfig;
  /** Absent means no mirror. v1 ships the protocol; the mirror follows. */
  mirror?: MirrorConfig;
}

export const DEFAULT_POLICY: PolicyConfig = {
  // `review` rather than `solo`: on this project's own construction one
  // independent reader of the plan found the two most serious defects in it,
  // both of which three implementing tracks had missed. See spec §5.6.
  planning: { mode: 'review', agents: 1, selection: 'leader' },
  selfCritique: { required: true, minRounds: 1 },
  leaderCritique: { maxRounds: 2 },
  dispute: {
    maxRounds: 3,
    ladder: ['discriminating_test', 'third_agent', 'leader'],
    rungTimeouts: { discriminating_test: '30m', third_agent: '30m', human: '4h' },
  },
  taskAcceptance: { method: 'leader' },
};
