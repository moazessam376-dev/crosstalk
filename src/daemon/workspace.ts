import { dirname, resolve } from 'node:path';

import type { CrosstalkConfig } from '../contracts/config.js';
import type { ParticipantId } from '../contracts/participant.js';
import { samePath } from '../workspace/git.js';

/**
 * Is `child` inside `parent`?
 *
 * Walks `child`'s ancestors and compares each with `samePath` rather than
 * doing a string prefix test. Two reasons, both learned the hard way: a prefix
 * test says `/repo/worktrees/codex-2` is inside `/repo/worktrees/codex`, and a
 * textual comparison misses 8.3 short names, junctions and `/private` on
 * macOS — the class of bug that had `removeWorktree` deleting registered
 * worktrees. `samePath` is the one hardened comparator; this reuses it instead
 * of growing a second.
 */
export async function isWithin(parent: string, child: string): Promise<boolean> {
  let current = resolve(child);
  for (;;) {
    if (await samePath(current, parent)) return true;
    const up = dirname(current);
    // `dirname` of a root is the root — the only reliable termination test.
    if (up === current) return false;
    current = up;
  }
}

/**
 * Is this participant's process where its configuration says it is?
 *
 * `doctor` validates the *declaration* hard — `WORKER_IN_REPO_ROOT`,
 * `WORKSPACE_OUTSIDE_REPO` and `BRIEF_OUTSIDE_WORKSPACE` are all reject-level —
 * and nothing has ever checked the process. Identity is resolved by whichever
 * `.mcp.json` the harness discovered from its working directory, so workspace
 * and identity are coupled through the filesystem and nothing else: a harness
 * that relocates itself re-resolves to a different participant, or to none.
 *
 * That is not hypothetical. Claude Code creates a per-session worktree under
 * `.claude/worktrees/<slug>` at session start, so sessions launched correctly
 * in `.crosstalk/worktrees/<id>` ran somewhere with no participant config at
 * all, fell back to the repo root, and authenticated as the leader — two of
 * them, for two rounds, with `doctor` reporting nothing the whole time,
 * because the configuration it validates was perfectly correct.
 *
 * A warning rather than a refusal: the CLI resolves identity from `--as`
 * against a token file and never from the working directory, so a strayed cwd
 * is not always wrong. Telling the agent is what was missing.
 */
export async function workspaceWarning(
  config: CrosstalkConfig,
  repo: string,
  who: ParticipantId,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (cwd === undefined || cwd.trim() === '') return undefined;

  const participant = config.participants.find((candidate) => candidate.id === who);
  if (participant === undefined) return undefined;

  const declared = resolve(repo, participant.workspace);
  if (await isWithin(declared, cwd)) return undefined;

  return (
    `You are authenticated as ${who}, but this process is running in ${cwd}, ` +
    `which is outside ${who}'s declared workspace ${participant.workspace}. ` +
    `Crosstalk resolves identity from whichever .mcp.json the harness finds from its ` +
    `working directory, so a relocated process can authenticate as a different ` +
    `participant — or as none. If you are not ${who}, stop and re-launch in ` +
    `${declared}; the CLI's --repo and --as flags resolve identity from the token ` +
    `file instead and are immune to whatever the harness does with its cwd.`
  );
}
