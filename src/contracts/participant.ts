/** Stable identifier for a participant, e.g. "leader", "codex", "@human". */
export type ParticipantId = string;

/**
 * `plan_reviewer` reads a plan before it is frozen and raises claims against
 * it (spec §5.6). Distinct from `observer`, which watches a dispute it is not
 * party to: a reviewer's whole purpose is to speak, and it needs its own brief
 * telling it explicitly not to implement.
 */
/**
 * `peer` is a leaderless builder: it starts from the `#floor` job directly,
 * coordinates on the board, and no participant holds task authority over it.
 * A roster is either led (exactly one leader) or flat (two or more peers,
 * no leader) — `doctor` refuses the mixtures.
 */
export type Role = 'leader' | 'worker' | 'observer' | 'human' | 'plan_reviewer' | 'spoc' | 'peer';

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
  /**
   * The model behind the harness, e.g. "grok-4.5", "composer-1", "luna-5.6".
   * A harness does not identify a model — several models run on `cursor-app`
   * and they do not behave alike, so the ledger aggregates by this field.
   */
  model?: string;
  /**
   * How hard the harness is told to think, e.g. "max", "high", "medium".
   *
   * Free text, not an enum, for the same reason `model` is: harnesses do not
   * agree on the scale, and a union of every harness's words would either
   * exclude one or mean nothing. A model at two effort levels does not behave
   * alike, so a ledger aggregating by participant is aggregating across this
   * whether or not it can see it.
   */
  effort?: string;
  /**
   * Repo-relative path prefixes this participant may write, e.g.
   * `["src/metrics/", "tests/metrics/"]`.
   *
   * Prefixes, not globs: the repo allows two runtime dependencies and neither
   * matches globs, and a hand-rolled matcher that is subtly wrong about `**`
   * would silently mis-scope the submit gate that reads this.
   *
   * Absent means "no declared ownership", which is what every config written
   * before shared root looks like, and which `doctor` requires of any worker
   * whose workspace is the repository root.
   */
  owns?: string[];
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
