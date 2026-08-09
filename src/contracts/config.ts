import type { Participant } from './participant.js';
import type { DecisionMethod, LadderRung } from './decision.js';

export interface ProjectConfig {
  /** Repo root, relative to the config file. */
  repo: string;
  mainBranch: string;
}

/** Durations are `"30m"`, `"4h"` — parsed by the consumer, not the contract. */
export type Duration = string;

export interface PolicyConfig {
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
  selfCritique: { required: true, minRounds: 1 },
  leaderCritique: { maxRounds: 2 },
  dispute: {
    maxRounds: 3,
    ladder: ['discriminating_test', 'third_agent', 'leader'],
    rungTimeouts: { discriminating_test: '30m', third_agent: '30m', human: '4h' },
  },
  taskAcceptance: { method: 'leader' },
};
