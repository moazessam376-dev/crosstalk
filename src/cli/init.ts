import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../contracts/config.js';
import type { Participant, ParticipantId, Role } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import { loadConfig } from '../daemon/config.js';
import { distPath } from '../daemon/paths.js';
import { tokenFilename } from '../daemon/server.js';
import { localBriefFile, seatTags, writeBrief } from '../harness/brief.js';
import { checkPrerequisites, doctor, type Finding } from '../harness/doctor.js';
import { loadRegistry, probeTier, resolveConfigPath, type HarnessDescriptor } from '../harness/registry.js';
import { writePresenceHook, writeSeatSettings } from '../harness/hooks.js';
import { SKILL_FILE, writeBoardSkill } from '../harness/skill.js';
import {
  branchSha,
  branchShaIfExists,
  createWorktree,
  deleteBranch,
  fastForwardBranch,
  isAncestor,
  isRepo,
  listWorktrees,
  removeWorktree,
  samePath,
} from '../workspace/git.js';
import { CliError, EXIT, stateDir } from './client.js';

const execFile = promisify(execFileCallback);

export interface InitOptions {
  repo: string;
  /** `id:role:harness[:model[:effort[:permission-mode]]]`, repeatable. Empty means the default roster. */
  participants: string[];
  force: boolean;
  /**
   * How the team works, by name — see `core/shape.ts`. Omitted keeps whatever
   * the roster on disk already names, for the same reason the roster itself is
   * read back rather than overwritten: `init` is also how you regenerate briefs
   * and `.mcp.json`, and doing that must not quietly demote a team to no shape.
   */
  shape?: string;
}

const DEFAULT_ROSTER = ['leader:leader:claude-code-app', 'codex:worker:codex-app'];

export interface McpRegistration {
  participantId: ParticipantId;
  /** Where it was written. Empty when the harness names no config path. */
  path: string;
  written: boolean;
  /** The exact registration — printed verbatim when it cannot be written. */
  entry: unknown;
  /** Why it was not written. Named, never silent. */
  reason?: string;
}

export interface InitResult {
  configPath: string;
  mcp: McpRegistration[];
  tokens: Map<string, string>;
  config: CrosstalkConfig;
  kickoff: { id: string; line: string }[];
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const repo = resolve(options.repo);
  const configPath = join(repo, 'crosstalk.yaml');

  if (!options.force && (await exists(configPath))) {
    throw new CliError(
      `${configPath} already exists`,
      EXIT.usage,
      'Pass --force to overwrite it. Tokens already minted are kept either way.',
    );
  }

  // An explicit `--participant` list means "this is the roster now". Absent
  // one, keep whatever is already configured.
  //
  // CT-20. Shared root is declared by `workspace:` and `owns:`, and `owns` is a
  // list, so neither fits the colon-separated spec — the roster has to be
  // hand-editable. But `--force` is mandatory once `crosstalk.yaml` exists, and
  // `init` never read the file it was overwriting: the only documented way to
  // regenerate `.mcp.json` and the briefs after an edit was also the way to
  // silently discard the edit, replacing a five-participant roster with the
  // two-participant default.
  const participants = options.participants.length > 0
    ? parseParticipants(options.participants)
    : (await configuredRoster(repo)) ?? parseParticipants(DEFAULT_ROSTER);

  // Refused before anything is written, with `doctor`'s own words. `init`
  // accepted two leaders happily, `doctor` rejected the result on the very next
  // command, and `up` started it anyway. A generator that emits what the
  // validator rejects is the bug, not the validator.
  const leaders = participants.filter((participant) => participant.role === 'leader');
  const peers = participants.filter((participant) => participant.role === 'peer');
  // Two shapes: led (exactly one leader, no peers) or flat (one or more peers,
  // no leader). A flat roster has no task authority on purpose — peers
  // coordinate on the board and no assign/accept machinery operates.
  //
  // One peer is flat, and used to be rejected. That made the `solo` shape —
  // one seat, no board, the control every team result is measured against —
  // impossible to initialise: the roster the benchmark exists to compare
  // against could not be written. Nothing about task authority needs a second
  // peer to be absent.
  const flat = leaders.length === 0 && peers.length >= 1;
  // A roster of nobody but the operator is the "not staffed yet" state that
  // `crosstalk up` writes so the hub can open on an unconfigured repo. The team
  // is chosen in the launcher, which calls back here with the real roster and
  // the rule below applies to it in full. `doctor` warns about it rather than
  // rejecting, for the same reason.
  const unstaffed = participants.every(
    (participant) => participant.role === 'human' || participant.role === 'observer',
  );
  if (!unstaffed && !flat && leaders.length !== 1) {
    throw new CliError(
      `LEADER_COUNT: Expected exactly one leader participant (or a flat roster of peers), found ${leaders.length} leader(s) and ${peers.length} peer(s).`,
      EXIT.protocol,
      'Configure exactly one participant with role: leader, or an all-peer roster with no leader.',
    );
  }
  if (!unstaffed && flat === false && peers.length > 0) {
    throw new CliError(
      `LEADER_COUNT: A roster is led or flat, not both — found ${leaders.length} leader(s) alongside ${peers.length} peer(s).`,
      EXIT.protocol,
      'Use worker seats under a leader, or make every builder a peer and remove the leader.',
    );
  }
  // Preserved, not defaulted. The shape is what the phase machine reads, and it
  // reached the config through nothing at all before this: `runCompose` passed
  // it to `runInit`, which had no such option and dropped it, so every team the
  // hub launched ran shapeless — no phases, no gates, and seats briefed without
  // the one thing that tells three peers how to be a team.
  const carried = await carriedConfig(repo);
  const shape = options.shape ?? carried.shape;

  const config: CrosstalkConfig = {
    version: 1,
    // Detected, not assumed. `mainBranch` was hard-coded to `main`, so on a
    // clone whose trunk is `master` the config `init` wrote named a branch that
    // does not exist — and staleness is measured against it (`staleness.ts:55`
    // calls `branchSha`), so the poller that expires evidence threw on its first
    // tick and every worker's base-branch check had nothing to compare against.
    project: { repo: '.', mainBranch: await currentBranch(repo) },
    participants,
    policy: DEFAULT_POLICY,
    ...(shape === undefined ? {} : { shape }),
    ...(carried.contractPath === undefined ? {} : { contractPath: carried.contractPath }),
    // Absent means no mirror, so an unset key is carried as unset rather than
    // defaulted into existence.
    ...(carried.mirror === undefined ? {} : { mirror: carried.mirror }),
  };

  // Issue #23. `init` was the only command that could leave a repository in a
  // state the other two refuse: on a repo with no commit it exited 0 and left
  // two worktrees on an unborn branch, four tokens and a config, and `doctor`
  // then rejected REPOSITORY_NO_COMMIT on the very next command. An empty
  // repository is the normal state for someone starting a project, which is
  // exactly how it was found.
  //
  // The same function `doctor` runs, not a second copy of the rule — the two
  // drifting apart is the defect, and this file has now fixed that shape three
  // times.
  const blocker = await checkPrerequisites(config, repo, repo);
  if (blocker !== undefined) {
    throw new CliError(`${blocker.code}: ${blocker.message}`, EXIT.protocol, blocker.remedy);
  }

  // CT-12, and in the same pre-write pass as the check above for the same
  // reason: a refusal must leave nothing behind. `init` writes the config and
  // mints tokens immediately below, so a throw from `ensureWorkspaces` would
  // strand a half-initialised repository that `init` itself then refuses to
  // re-enter ("crosstalk.yaml already exists") unless the operator knows to
  // reach for --force.
  await ensureBaseBranches(repo, participants, config.project.mainBranch);

  await writeFile(configPath, stringify(config), 'utf8');
  await mkdir(join(stateDir(repo), 'tokens'), { recursive: true });

  // Minted here and reused by `startDaemon`, so the token embedded in
  // .mcp.json stays valid across restarts.
  const tokens = new Map<string, string>();
  for (const participant of participants) {
    const path = join(stateDir(repo), 'tokens', tokenFilename(participant.id));
    const existing = await readFile(path, 'utf8').then((raw) => raw.trim()).catch(() => '');
    const token = existing === '' ? randomBytes(32).toString('hex') : existing;
    if (existing === '') await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
    tokens.set(participant.id, token);
  }

  await ensureWorkspaces(repo, participants);
  const mcp = await writeMcpConfigs(repo, participants);
  await ensureGitignored(repo);
  await writeBriefs(repo, participants, config.policy, config.shape);

  return { configPath, mcp, tokens, config, kickoff: await kickoffLines(repo, participants) };
}

/**
 * Every worker gets its own checkout, on `ct/<id>-base` off the current head.
 *
 * `init` used to write `workspace: .crosstalk/worktrees/<id>` into the config
 * and never create the directory, so two agents shared the leader's working
 * tree — the failure design §7 exists to prevent.
 *
 * Existing worktrees are reused, never recreated: `init --force` must not
 * destroy a worker's uncommitted work.
 */
async function ensureWorkspaces(repo: string, participants: Participant[]): Promise<void> {
  const root = resolve(repo);
  // Not a repository is `doctor`'s REPOSITORY_UNAVAILABLE to report, not ours
  // to crash on. B2 makes `up` refuse to start on it.
  if (!(await isRepo(root))) return;

  await excludeFromEveryWorktree(root, await untrackedArtifacts());

  for (const participant of participants) {
    if (!needsWorktree(participant.role)) continue;
    // CT-20. A worker that shares the repository root has no worktree to build,
    // and building one anyway is not merely wasted: it puts a directory under
    // `.crosstalk/worktrees/<id>` and a `ct/<id>-base` branch in the project
    // that nothing ever checks out, which is the tree clutter shared root was
    // asked for to remove.
    if (resolve(root, participant.workspace) === root) continue;
    const worktree = join(root, '.crosstalk', 'worktrees', participant.id);
    if (!(await isRegistered(root, worktree))) {
      await addWorktree(root, participant.id, `ct/${participant.id}-base`, worktree);
    }
  }
}

/**
 * The branch this checkout is actually on, or `main` when there is nothing to
 * ask — not a repository, or a repository with no commit yet, where `init`
 * refuses anyway via `checkPrerequisites`.
 *
 * `--show-current` prints an empty string on a detached HEAD, which is a state
 * `mainBranch` cannot be read from; `main` is the honest default there and the
 * operator can edit one line of `crosstalk.yaml`.
 */
async function currentBranch(repo: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['branch', '--show-current'], {
      cwd: resolve(repo),
      windowsHide: true,
    });
    return stdout.trim() === '' ? 'main' : stdout.trim();
  } catch {
    return 'main';
  }
}

/**
 * No worker is ever handed a checkout older than the main branch. CT-12.
 *
 * `purgeWorkspaces` removed a worker's worktree and pruned its administrative
 * entry but left `ct/<id>-base` pointing at whatever commit it last held. A
 * later `init` found the branch alive, and `addWorktree`'s fallback checked a
 * worktree out onto it — at the old commit, silently. `doctor` reported nothing,
 * because the configuration it validates was perfectly correct. On the machine
 * where this was found, the stale commit still carried the *old* tracked brief,
 * so every worker worktree held two briefs disagreeing about who the agent was
 * and one of them said it was the leader.
 *
 * Ancestor gets fast-forwarded; diverged is refused. Refusing is right: a
 * diverged base holds commits nobody asked to discard, and silently checking
 * them out is the bug. Only branches whose worktree is *not* registered are
 * touched — a live worktree's branch is not `init`'s to move, and a registered
 * worktree that has fallen behind is `doctor`'s WORKTREE_BEHIND_MAIN.
 */
async function ensureBaseBranches(
  repo: string,
  participants: Participant[],
  mainBranch: string,
): Promise<void> {
  const root = resolve(repo);
  if (!(await isRepo(root))) return;

  const workers = participants.filter((participant) => needsWorktree(participant.role));
  if (workers.length === 0) return;

  // Through `branchSha`, whose message already names the remedy. Reaching for
  // `isAncestor` directly would be worse than wrong: git exits 128 for an
  // unknown revision and `isAncestor` rethrows anything that is not exit 1, so
  // a clone whose default branch is `master` would get a raw stack trace.
  let mainSha: string;
  try {
    mainSha = await branchSha(root, mainBranch);
  } catch (error) {
    throw new CliError(
      `Cannot resolve the main branch "${mainBranch}"`,
      EXIT.protocol,
      (error as Error).message,
    );
  }

  for (const participant of workers) {
    const worktree = join(root, '.crosstalk', 'worktrees', participant.id);
    if (await isRegistered(root, worktree)) continue;

    const branch = `ct/${participant.id}-base`;
    const sha = await branchShaIfExists(root, branch);
    if (sha === undefined || sha === mainSha) continue;

    if (await isAncestor(sha, mainSha, root)) {
      await fastForwardBranch(root, branch, mainSha);
      continue;
    }

    throw new CliError(
      `${branch} has diverged from ${mainBranch}, so ${participant.id} would be given an out-of-date checkout.\n` +
        `  ${branch} is at ${sha.slice(0, 7)}\n` +
        `  ${mainBranch} is at ${mainSha.slice(0, 7)}`,
      EXIT.protocol,
      `That branch holds commits ${mainBranch} does not. Merge or rebase it, or delete it with \`git branch -D ${branch}\` if the work is finished with, then run \`crosstalk init\` again.`,
    );
  }
}

/**
 * Design §11: the config is "validated at startup by `crosstalk doctor`". It
 * was not — `up` called `startDaemon` directly, so a configuration `doctor`
 * rejected with exit 1 started anyway and bound a port.
 *
 * Runs before anything binds, so a refusal leaves no daemon behind. Warnings
 * are returned for the caller to print and are never fatal: the roster `init`
 * itself writes produces two of them, and a `up` that refused its own output
 * would be worse than the bug.
 *
 * `--force` is for someone who knows better than the checker, which is why it
 * returns the findings rather than swallowing them.
 */
export async function preflight(repo: string, force: boolean): Promise<Finding[]> {
  const findings = await doctor(await loadConfig(repo), repo);
  const rejects = findings.filter((finding) => finding.level === 'reject');
  if (rejects.length === 0 || force) return findings;

  throw new CliError(
    rejects.map((finding) => `${finding.code}: ${finding.message}`).join('\n'),
    EXIT.protocol,
    `${rejects[0]!.remedy} Or pass --force to start anyway.`,
  );
}

/**
 * The other half of `ensureWorkspaces`, for `down --purge`. AGENTS.md rule 9:
 * anything created under `.crosstalk/` has to be findable and removable here,
 * or a reviewer cannot tell a stray directory from an abandoned one.
 *
 * Driven from the config rather than from whatever is on disk, so it removes
 * what Crosstalk created and never a worktree the user added themselves.
 */
export async function purgeWorkspaces(repo: string): Promise<void> {
  const root = resolve(repo);
  let config: CrosstalkConfig;
  try {
    config = await loadConfig(root);
  } catch {
    // No config left to say what we made. `down --purge` still succeeds.
    return;
  }

  for (const participant of config.participants) {
    if (!needsWorktree(participant.role)) continue;
    const worktree = join(root, '.crosstalk', 'worktrees', participant.id);
    // The branch is deleted whether or not the worktree is still registered:
    // half a purge leaves exactly the CT-12 state this is here to prevent.
    const branch = `ct/${participant.id}-base`;
    if (!(await isRegistered(root, worktree))) {
      await deleteBranch(root, branch);
      continue;
    }

    try {
      await removeWorktree(root, participant.id);
    } catch {
      // `removeWorktree` runs `git worktree remove` without `--force`, which
      // refuses any worktree holding untracked files — and `init` writes the
      // participant's brief into every worktree it creates, so that is all of
      // them. Raised with Track A, who own that helper; until it takes a force
      // option, `--purge` does here what the flag already promises.
      await execFile('git', ['worktree', 'remove', '--force', worktree], { cwd: root, windowsHide: true });
    }
    // After the worktree, never before: git refuses to delete a branch a
    // worktree still holds.
    await deleteBranch(root, branch);
  }

  // Drops any administrative entry whose directory is already gone, so a later
  // `init` sees a clean list rather than a stale registration.
  await execFile('git', ['worktree', 'prune'], { cwd: root, windowsHide: true }).catch(() => undefined);

  await purgeUnreferencedBlobs(root);
}

/**
 * Remove attached files nothing in this repository still points at.
 *
 * `--purge` is the scratch broom, and an attachment is only scratch once no
 * record mentions it. So this reads the live log *and* every archive, and
 * deletes what neither names — the same mark-and-sweep the daemon runs after a
 * run is deleted, spelled out here because `down --purge` runs with no daemon.
 *
 * **`runs/` is deliberately left alone.** Archives are history, and they
 * follow the event log's rule — "the event log and tokens are kept" — not the
 * scratch rule. Removing one stays an explicit, confirmed act: `ct runs rm`.
 */
async function purgeUnreferencedBlobs(root: string): Promise<void> {
  const stateDir = join(root, '.crosstalk');
  const keep = new Set<string>();
  const mark = (raw: string): void => {
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line) as { attachments?: { sha: string }[] };
        for (const attachment of event.attachments ?? []) keep.add(attachment.sha);
      } catch {
        // A half-written line is a reason to keep more, not less.
        return;
      }
    }
  };

  try {
    mark(await readFile(join(stateDir, 'events.jsonl'), 'utf8'));
  } catch {
    // No log, nothing referenced — but also nothing that could have been.
  }
  let archives: string[] = [];
  try {
    archives = await readdir(join(stateDir, 'runs'));
  } catch {
    archives = [];
  }
  for (const name of archives) {
    try {
      mark(await readFile(join(stateDir, 'runs', name), 'utf8'));
    } catch {
      // Unreadable archive: refuse to sweep rather than collect its blobs.
      return;
    }
  }

  const { BlobStore } = await import('../daemon/blobs.js');
  // No age floor here: `down` means nobody is composing a message, so there is
  // no just-uploaded blob waiting to be referenced.
  await new BlobStore(stateDir).sweep(keep, Date.now(), 0);
}

async function isRegistered(root: string, worktree: string): Promise<boolean> {
  try {
    for (const entry of await listWorktrees(root)) {
      if (await samePath(entry.path, worktree)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * `createWorktree` always passes `-b`, which fails when the branch survives its
 * worktree — exactly what `down --purge` then `init` leaves behind. Falling
 * back to a checkout of the existing branch keeps re-initialising idempotent.
 */
async function addWorktree(root: string, id: string, branch: string, worktree: string): Promise<void> {
  try {
    await createWorktree(root, id, branch);
  } catch {
    await mkdir(dirname(worktree), { recursive: true });
    await execFile('git', ['worktree', 'add', worktree, branch], { cwd: root, windowsHide: true });
  }
}

/**
 * A linked worktree resolves `.mcp.json` against its own root, so the
 * top-level `.gitignore`'s `.crosstalk/` rule does not match it and the
 * participant token B3 writes there lands untracked-but-stageable on a branch
 * the worker is expected to push.
 *
 * `info/exclude` rather than a `.gitignore`: the ignore file belongs to the
 * user, and Crosstalk should not be editing one inside their branch.
 *
 * It goes in the **common** git dir, not the per-worktree one. Git reads
 * `info/exclude` only from the common directory — verified, because the
 * per-worktree copy is silently ignored — which is convenient: one write
 * covers the primary checkout and every linked worktree at once.
 */
/**
 * Which seats get a checkout of their own.
 *
 * `peer` was missing, and the omission was invisible until three peer seats
 * launched into directories that held nothing but their brief. They improvised
 * — one wrote source into an ignored path and posted a stale environment note
 * that misled the board for ten minutes — and the operator rebuilt real
 * worktrees around the mess mid-run. A role that writes code needs somewhere to
 * write it.
 */
function needsWorktree(role: string): boolean {
  return role === 'worker' || role === 'peer';
}

async function excludeFromEveryWorktree(root: string, patterns: string[]): Promise<void> {
  let gitDir: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--git-common-dir'], { cwd: root, windowsHide: true });
    gitDir = resolve(root, stdout.trim());
  } catch {
    return;
  }

  const path = join(gitDir, 'info', 'exclude');
  const current = await readFile(path, 'utf8').catch(() => '');

  const missing = patterns.filter((pattern) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^${escaped}$`, 'm').test(current);
  });
  if (missing.length === 0) return;

  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${current}${prefix}\n# Crosstalk writes per-participant files here: bearer tokens and role briefs.\n${missing.join('\n')}\n`,
    'utf8',
  );
}

/**
 * Everything `init` writes into a worktree that git must not follow.
 *
 * The briefs are the CT-4 half: `CLAUDE.local.md` rather than the tracked
 * `CLAUDE.md`. A bare filename in `info/exclude` matches at any depth, so one
 * entry covers the primary checkout and every worker worktree.
 */
async function untrackedArtifacts(): Promise<string[]> {
  const registry = await loadRegistry().catch(() => undefined);
  if (registry === undefined) return ['.mcp.json'];

  const patterns = new Set<string>([
    '.mcp.json',
    // The seat settings written for claude-code participants: the presence
    // hook, the env it reads, and the MCP trust flag. Same reason as
    // `.mcp.json` — Crosstalk wrote it into somebody's checkout, so Crosstalk
    // has to keep it out of their next commit.
    '.claude/settings.json',
    // The generated board skill. Same reason as the two above: crosstalk wrote
    // it into somebody's checkout, so crosstalk keeps it out of their commit.
    SKILL_FILE.replace(/\\/g, '/'),
  ]);
  for (const descriptor of registry.values()) {
    patterns.add(basename(localBriefFile(descriptor.briefFile)));
    // CT-20. A shared-root participant's brief carries its id — `CLAUDE.md`
    // becomes `CLAUDE.metrics.local.md` — and the unscoped entry above does not
    // match it. Without the glob, git follows every shared-root brief, which is
    // CT-4 arriving again by the new route: a worker committing with
    // `git add -A` would commit its own brief into the project.
    patterns.add(basename(localBriefFile(descriptor.briefFile, '*')));

    // Every registration B3 writes carries a participant's bearer token, and
    // `.mcp.json` is only the one at the root: `cursor-*` registers at
    // `.cursor/mcp.json`, which nothing excluded. Found by running `init` and
    // checking each written path rather than the one I remembered.
    //
    // Skipped for `~/...` and absolute paths — B3 never writes those, and an
    // exclude entry for a file outside the repository would be noise.
    const configPath = descriptor.mcpConfigPath;
    if (configPath !== undefined && !configPath.startsWith('~') && !isAbsolute(configPath)) {
      patterns.add(configPath.replace(/\\/g, '/'));
    }
  }
  return [...patterns];
}

/**
 * The brief `doctor` expects, written at the same probed tier `doctor` checks
 * against — otherwise `init` and `doctor` disagree about a file `init` wrote
 * seconds earlier, which is what BRIEF_STALE was reporting on every fresh repo.
 */
async function writeBriefs(
  repo: string,
  participants: Participant[],
  policy: CrosstalkConfig['policy'],
  shape?: string,
): Promise<void> {
  let hookPath: string | undefined;
  let registry: Map<string, HarnessDescriptor>;
  try {
    registry = await loadRegistry();
  } catch {
    return;
  }

  for (const participant of participants) {
    // `@human` runs no harness — it participates through the hub in a browser.
    if (participant.id === HUMAN_ID) continue;
    const descriptor = registry.get(participant.harness);
    if (descriptor === undefined) continue;

    const tier = participant.transport ?? (await probeTier(descriptor, resolve(repo, participant.workspace)));
    await writeBrief(participant, descriptor, policy, tier, repo, shape);

    // Only harnesses that read this settings format: the hook config and the
    // trust flag are Claude Code's, and writing them for a harness that ignores
    // them would be clutter claiming to be configuration.
    //
    // Asked of the registry rather than pattern-matched off the key. A harness
    // named outside the convention got nothing, silently, and the convention
    // was never a contract.
    if (descriptor.settings === 'claude-code') {
      await writeSeatSettings({
        repo,
        workspace: participant.workspace,
        seat: participant.id,
        scriptPath: hookPath ?? (hookPath = await writePresenceHook(repo)),
      });
      // The board vocabulary as a skill, rendered from the same record the
      // tool schema and every refusal render from — so it cannot drift from
      // what the daemon actually enforces. Only where the shape names this
      // seat's tags: with no shape nothing is enforced, and a skill teaching an
      // unenforced schema is a rule that is not real.
      const tags = seatTags(participant, shape);
      if (tags !== undefined) {
        await writeBoardSkill({ repo, workspace: participant.workspace, tags });
      }
    }
  }
}

/**
 * Interfaces spec §1. The url is deliberately absent: the MCP server reads it
 * from `.crosstalk/daemon.json`, because this file is written before any
 * daemon exists and an ephemeral port cannot be predicted.
 */
/**
 * The registration, identical everywhere it is written or printed.
 *
 * The token is *referenced*, never embedded. A live bearer token in a config
 * file is worth removing on its own merits, and a missing token file fails
 * loudly where an empty string would 401 with nothing to explain it.
 */
function registrationFor(root: string, participantId: ParticipantId): unknown {
  return {
    command: 'node',
    // Interfaces spec §1: absolute, because the package is unpublished.
    args: [distPath(import.meta.url, 'mcp', 'index.js')],
    env: {
      CROSSTALK_REPO: root,
      CROSSTALK_TOKEN_FILE: join(stateDir(root), 'tokens', tokenFilename(participantId)),
    },
  };
}

/**
 * One registration per participant, in that participant's own workspace,
 * carrying that participant's token.
 *
 * A single shared registration meant every agent but one fell back to the CLI,
 * and worker worktrees — where the GUI harnesses are actually opened — got
 * nothing at all. It also meant two agents opened on the same folder presented
 * the same token, and `from` is the field the ledger attributes by.
 */
async function writeMcpConfigs(
  repo: string,
  participants: Participant[],
): Promise<McpRegistration[]> {
  const root = resolve(repo);
  let registry: Map<string, HarnessDescriptor>;
  try {
    registry = await loadRegistry();
  } catch {
    return [];
  }

  const registrations: McpRegistration[] = [];
  for (const participant of participants) {
    // `@human` runs no harness; it joins through the hub in a browser.
    if (participant.id === HUMAN_ID) continue;
    const descriptor = registry.get(participant.harness);
    if (descriptor === undefined) continue;

    const entry = registrationFor(root, participant.id);
    const add = (path: string, written: boolean, reason?: string): void => {
      registrations.push({ participantId: participant.id, path, written, entry, ...(reason === undefined ? {} : { reason }) });
    };

    // Transport first, path second. The other order made `mcp` a dead field:
    // `codex-app` declares `mcp: unverified` *and* no `mcpConfigPath`, so the
    // path guard always fired first and the reported reason was "no
    // mcpConfigPath" — the declared transport could never be the answer, for
    // any harness. Naming the wrong reason is worse than naming none, because
    // the remedy that follows from it is the one you cannot act on.
    if (descriptor.mcp !== 'stdio') {
      add('', false, `harness ${descriptor.key} declares mcp: ${descriptor.mcp}, not stdio — Crosstalk has no verified way to drive it over MCP`);
      continue;
    }
    if (descriptor.mcpConfigPath === undefined) {
      add('', false, `harness ${descriptor.key} names no mcpConfigPath, so there is nowhere to register`);
      continue;
    }

    const path = resolveConfigPath(descriptor.mcpConfigPath, resolve(root, participant.workspace));
    if (!isWithin(root, path)) {
      // `~/.codex/config.toml` and the like. Crosstalk does not edit files
      // outside the repository it was pointed at, so it prints instead.
      add(path, false, `${path} is outside the repository`);
      continue;
    }

    await mergeRegistration(path, participant.id, entry);
    add(path, true);
  }
  return registrations;
}

function isWithin(parent: string, target: string): boolean {
  const child = relative(resolve(parent), resolve(target));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

/**
 * Merge, never overwrite.
 *
 * This file belongs to the user, not to Crosstalk. Anyone running `init` on a
 * real project is likely to already have MCP servers configured, and the first
 * version of this function replaced the whole file — silently deleting every
 * one of them. `crosstalk.yaml` and the tokens were already preserved across a
 * re-init; this was the one path that was not, and it was the one that
 * destroyed something the user wrote.
 *
 * An unparseable file is left alone and reported. Rewriting JSON we failed to
 * understand is how the damage would happen twice.
 */
async function mergeRegistration(path: string, id: string, entry: unknown): Promise<void> {
  const existing = await readJsonObject(path);
  if (existing === 'unreadable') {
    throw new CliError(
      `${path} exists but is not valid JSON, so it cannot be merged safely.`,
      EXIT.usage,
      'Fix or move that file, then run `crosstalk init` again. Crosstalk will not rewrite JSON it could not read.',
    );
  }

  const servers = isRecord(existing?.['mcpServers']) ? { ...existing['mcpServers'] } : {};
  // CT-20. Keyed by participant, because in shared root every harness reads
  // this one file: a single fixed `crosstalk` key meant the last participant
  // written won and every agent authenticated as it, which is CT-8 and CT-9.
  //
  // The old key is removed rather than left beside the new ones. It is
  // Crosstalk's own, not the user's, and leaving it would leave a server that
  // authenticates as whichever participant happened to write it last — the
  // exact confusion this change exists to end. Everything else in the file is
  // still untouched.
  delete servers['crosstalk'];
  servers[`crosstalk-${id}`] = entry;

  const merged = { ...(existing ?? {}), mcpServers: servers };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `undefined` when absent, `'unreadable'` when present and not a JSON object. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined | 'unreadable'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  if (raw.trim() === '') return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * Tokens must never be committable — in either of the two places one lands.
 *
 * `.mcp.json` carries a participant's bearer token in `env.CROSSTALK_TOKEN` and
 * sits at the repository root, where nothing ignored it. That was survivable
 * while every checkout was private; it is not now that `init` runs against
 * public repositories.
 */
async function ensureGitignored(repo: string): Promise<void> {
  const path = join(repo, '.gitignore');
  const current = await readFile(path, 'utf8').catch(() => '');

  const covered = (pattern: RegExp): boolean => pattern.test(current);
  const additions: string[] = [];

  if (!covered(/^\.crosstalk\/?$/m) && !covered(/^\.crosstalk\/tokens\/?$/m)) {
    additions.push('# Crosstalk runtime state — tokens live here and must never be committed', '.crosstalk/');
  }
  if (!covered(/^\/?\.mcp\.json$/m)) {
    additions.push("# Crosstalk writes this participant's bearer token here", '.mcp.json');
  }
  if (additions.length === 0) return;

  const prefix = current.endsWith('\n') || current === '' ? '' : '\n';
  await writeFile(path, `${current}${prefix}\n${additions.join('\n')}\n`, 'utf8');
}

/**
 * The line a human pastes into each agent.
 *
 * CT-2: branched on `participant.harness.startsWith('claude-code')`, so in one
 * `init` run Crosstalk wrote `cursor-app` an MCP registration, reported no
 * `MCP_PROBE_FALLBACK` — asserting the mcp tier was healthy — and then told the
 * agent to use the shell tier anyway. `probeTier` already computed the right
 * answer; the generator simply never asked it.
 *
 * CT-3: the shell line emitted a bare `ct`, which is only correct if Crosstalk
 * is globally installed *and* that global install is this build. On the machine
 * where this was found both halves were false (CT-1), so the line Crosstalk
 * printed ran a different checkout against the project it had just written.
 * The invocation is resolved to this package's own CLI instead.
 */
async function kickoffLines(
  repo: string,
  participants: Participant[],
): Promise<{ id: string; line: string }[]> {
  const registry = await loadRegistry().catch(() => undefined);
  const cli = `node ${distPath(import.meta.url, 'cli', 'index.js')}`;
  const root = resolve(repo);
  const lines: { id: string; line: string }[] = [];

  for (const participant of participants) {
    if (participant.role === 'human') continue;

    const descriptor = registry?.get(participant.harness);
    const workspace = resolve(root, participant.workspace);
    const tier = descriptor === undefined
      ? 'shell'
      : participant.transport ?? (await probeTier(descriptor, workspace));

    lines.push({
      id: participant.id,
      // `workspace`, never `root`. The shell branch used to name the repository
      // root for every participant, so each shell-tier worker was told to work
      // in the leader's checkout — two agents in one working tree, which is the
      // failure design §7 exists to prevent, arriving by a second route.
      //
      // `--repo` still points at the root: that is where tokens and the daemon
      // descriptor live, and passing it explicitly makes identity immune to
      // whatever the harness does with its working directory.
      line: tier === 'mcp'
        // CT-20. Names the *server*, not just the file. In a shared root three
        // participants are registered in one `.mcp.json`, so "your MCP server is
        // registered at <path>" points at a file holding somebody else's
        // credentials as well as yours, and the agent has no way to tell which
        // entry is its own.
        ? `You are "${participant.id}". Call inbox(). Open this agent in ${workspace} — your MCP server is \`crosstalk-${participant.id}\`, registered at ${resolveConfigPath(descriptor!.mcpConfigPath!, workspace)}, and its token is yours alone.`
        : `You are "${participant.id}". Work in ${workspace} — that is your checkout, not the leader's. Use the CLI: \`${cli} inbox --repo ${root} --as ${participant.id}\` to receive work, \`${cli} say --repo ${root} --as ${participant.id} --room '#floor' --body '...'\` to speak.`,
    });
  }
  return lines;
}

/**
 * The roster already in `crosstalk.yaml`, or `undefined` if there is none.
 *
 * Read through `loadConfig` rather than parsed here: that function's own comment
 * is that the CLI shares it because two loaders disagreeing about defaults is a
 * bug with a long fuse, and a second parser in this file is exactly that bug.
 *
 * Unreadable is treated as absent rather than fatal. Someone re-running `init`
 * with `--force` on a config they have broken is asking to have it rebuilt, and
 * refusing would leave them with no way through except deleting the file.
 */
/**
 * Everything a regeneration must carry across, as one list.
 *
 * It was `configuredShape`, returning one field, and the omission is why the
 * GitHub mirror is never configured on any run: the mirror is enabled by
 * hand-editing `crosstalk.yaml` — `init` writes no mirror key and `doctor`'s
 * remedy says to add one — and then `--force` rebuilt the file from the shape
 * and the roster alone. The hub calls `runInit({force: true})` on every launch
 * whose roster or shape differs, so the block was gone before the first message,
 * every time, with nothing said about it.
 *
 * One function rather than one per key, so the next field added to
 * `CrosstalkConfig` has a single obvious place to be remembered.
 */
async function carriedConfig(repo: string): Promise<Partial<CrosstalkConfig>> {
  try {
    const existing = await loadConfig(repo);
    return {
      ...(existing.shape === undefined ? {} : { shape: existing.shape }),
      ...(existing.contractPath === undefined ? {} : { contractPath: existing.contractPath }),
      ...(existing.mirror === undefined ? {} : { mirror: existing.mirror }),
    };
  } catch {
    return {};
  }
}

async function configuredRoster(repo: string): Promise<Participant[] | undefined> {
  try {
    const existing = await loadConfig(repo);
    return existing.participants.length > 0 ? existing.participants : undefined;
  } catch {
    return undefined;
  }
}

function parseParticipants(specs: string[]): Participant[] {
  const participants: Participant[] = specs.map((spec) => {
    // Fields are only ever appended, so every spec ever written keeps parsing
    // to exactly what it parsed to before (claim CT-A).
    const [id, role, harness, model, effort, permissionMode] = spec.split(':');
    if (!id || !role || !harness) {
      throw new CliError(
        `Cannot read participant "${spec}"`,
        EXIT.usage,
        'Use --participant id:role:harness[:model[:effort[:permission-mode]]], for example --participant codex:worker:codex-cli:gpt-5.6-luna:max',
      );
    }
    if (!['leader', 'worker', 'observer', 'human', 'spoc', 'peer'].includes(role)) {
      throw new CliError(`Unknown role "${role}" in "${spec}"`, EXIT.usage, 'Roles: leader, worker, observer, human, spoc, peer.');
    }
    return {
      id,
      role: role as Role,
      harness,
      ...(model === undefined ? {} : { model }),
      // Conditional, like `model`: a written `effort: ""` renders as a blank
      // beside the model and reads as a configured value rather than as
      // "nobody said".
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      lifecycle: 'attached' as const,
      // The primary checkout is the leader's and no worker may occupy it.
      workspace: role === 'leader' || role === 'spoc' || role === 'human' || role === 'observer'
        ? '.'
        : join('.crosstalk', 'worktrees', id).replace(/\\/g, '/'),
    };
  });

  // @human is a participant in every room (spec §9) and needs a token of its
  // own: the browser bootstrap presents it, and `from` comes from the token.
  if (!participants.some((participant) => participant.id === HUMAN_ID)) {
    participants.push({
      id: HUMAN_ID,
      role: 'human',
      harness: 'human',
      lifecycle: 'attached',
      workspace: '.',
    });
  }
  return participants;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
