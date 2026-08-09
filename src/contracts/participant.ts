/** Stable identifier for a participant, e.g. "leader", "codex", "@human". */
export type ParticipantId = string;

export type Role = 'leader' | 'worker' | 'observer' | 'human';

/**
 * How a participant reaches the hub. Descending fidelity: `mcp` validates
 * in-band, `shell` validates by exit code, `file` validates a turn later.
 */
export type Tier = 'mcp' | 'shell' | 'file';

/** `supervised` requires a CLI harness; a GUI session cannot be spawned. */
export type Lifecycle = 'attached' | 'supervised';

export interface Participant {
  id: ParticipantId;
  role: Role;
  /** Key into the harness registry, e.g. "codex-cli", "cursor-app". */
  harness: string;
  lifecycle: Lifecycle;
  /** Repo-relative path to this participant's worktree. Resolved at runtime. */
  workspace: string;
  /** Normally omitted — `doctor` probes it. Set only to pin the tier. */
  transport?: Tier;
}

/**
 * Participant ids are used as directory names, so they are constrained to
 * survive a case-insensitive filesystem and Windows MAX_PATH. See
 * docs/CROSS-PLATFORM.md §4.
 */
export const PARTICIPANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
