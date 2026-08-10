import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../contracts/config.js';
import type { Participant, Role } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import { loadConfig } from '../daemon/config.js';
import { distPath } from '../daemon/paths.js';
import { tokenFilename } from '../daemon/server.js';
import { writeBrief } from '../harness/brief.js';
import { doctor, type Finding } from '../harness/doctor.js';
import { loadRegistry, probeTier, type HarnessDescriptor } from '../harness/registry.js';
import { createWorktree, isRepo, listWorktrees, removeWorktree } from '../workspace/git.js';
import { CliError, EXIT, stateDir } from './client.js';

const execFile = promisify(execFileCallback);

export interface InitOptions {
  repo: string;
  /** `id:role:harness[:model]`, repeatable. Empty means the default roster. */
  participants: string[];
  force: boolean;
}

const DEFAULT_ROSTER = ['leader:leader:claude-code-app', 'codex:worker:codex-app'];

export interface InitResult {
  configPath: string;
  mcpPath: string;
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

  const participants = parseParticipants(
    options.participants.length > 0 ? options.participants : DEFAULT_ROSTER,
  );

  // Refused before anything is written, with `doctor`'s own words. `init`
  // accepted two leaders happily, `doctor` rejected the result on the very next
  // command, and `up` started it anyway. A generator that emits what the
  // validator rejects is the bug, not the validator.
  const leaders = participants.filter((participant) => participant.role === 'leader');
  if (leaders.length !== 1) {
    throw new CliError(
      `LEADER_COUNT: Expected exactly one leader participant, found ${leaders.length}.`,
      EXIT.protocol,
      'Configure exactly one participant with role: leader; all other agents should be workers or observers.',
    );
  }
  const config: CrosstalkConfig = {
    version: 1,
    project: { repo: '.', mainBranch: 'main' },
    participants,
    policy: DEFAULT_POLICY,
  };

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
  const mcpPath = await writeMcpConfig(repo, participants, tokens);
  await ensureGitignored(repo);
  await writeBriefs(repo, participants, config.policy);

  return { configPath, mcpPath, tokens, config, kickoff: kickoffLines(repo, participants) };
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

  await excludeTokensFromEveryWorktree(root);

  for (const participant of participants) {
    if (participant.role !== 'worker') continue;
    const worktree = join(root, '.crosstalk', 'worktrees', participant.id);
    if (!(await isRegistered(root, worktree))) {
      await addWorktree(root, participant.id, `ct/${participant.id}-base`, worktree);
    }
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
    if (participant.role !== 'worker') continue;
    const worktree = join(root, '.crosstalk', 'worktrees', participant.id);
    if (!(await isRegistered(root, worktree))) continue;

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
  }

  // Drops any administrative entry whose directory is already gone, so a later
  // `init` sees a clean list rather than a stale registration.
  await execFile('git', ['worktree', 'prune'], { cwd: root, windowsHide: true }).catch(() => undefined);
}

function samePath(left: string, right: string): boolean {
  const [a, b] = [resolve(left), resolve(right)];
  return process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function isRegistered(root: string, worktree: string): Promise<boolean> {
  try {
    return (await listWorktrees(root)).some((entry) => samePath(entry.path, worktree));
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
async function excludeTokensFromEveryWorktree(root: string): Promise<void> {
  let gitDir: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--git-common-dir'], { cwd: root, windowsHide: true });
    gitDir = resolve(root, stdout.trim());
  } catch {
    return;
  }

  const path = join(gitDir, 'info', 'exclude');
  const current = await readFile(path, 'utf8').catch(() => '');
  if (/^\.mcp\.json$/m.test(current)) return;

  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${current}${prefix}\n# Crosstalk writes this participant's bearer token here.\n.mcp.json\n`,
    'utf8',
  );
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
): Promise<void> {
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
    await writeBrief(participant, descriptor, policy, tier, repo);
  }
}

/**
 * Interfaces spec §1. The url is deliberately absent: the MCP server reads it
 * from `.crosstalk/daemon.json`, because this file is written before any
 * daemon exists and an ephemeral port cannot be predicted.
 */
async function writeMcpConfig(
  repo: string,
  participants: Participant[],
  tokens: Map<string, string>,
): Promise<string> {
  const agent =
    participants.find((participant) => participant.harness.startsWith('claude-code')) ??
    participants.find((participant) => participant.role === 'worker') ??
    participants[0]!;

  const path = join(repo, '.mcp.json');
  const entry = {
    command: 'node',
    // Interfaces spec §1: absolute, because the package is unpublished.
    args: [distPath(import.meta.url, 'mcp', 'index.js')],
    env: {
      CROSSTALK_REPO: resolve(repo),
      CROSSTALK_TOKEN: tokens.get(agent.id) ?? '',
    },
  };

  // Merge, never overwrite.
  //
  // This file belongs to the user, not to Crosstalk. Anyone running `init` on a
  // real project is likely to already have MCP servers configured, and the
  // first version of this function replaced the whole file — silently deleting
  // every one of them. `crosstalk.yaml` and the tokens were already preserved
  // across a re-init; this was the one path that was not, and it was the one
  // that destroyed something the user wrote.
  //
  // An unparseable file is left alone and reported. Rewriting JSON we failed to
  // understand is how the damage would happen twice.
  const existing = await readJsonObject(path);
  if (existing === 'unreadable') {
    throw new CliError(
      `${path} exists but is not valid JSON, so it cannot be merged safely.`,
      EXIT.usage,
      'Fix or move that file, then run `crosstalk init` again. Crosstalk will not rewrite JSON it could not read.',
    );
  }

  const servers = isRecord(existing?.['mcpServers']) ? { ...existing['mcpServers'] } : {};
  servers['crosstalk'] = entry;

  const merged = { ...(existing ?? {}), mcpServers: servers };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return path;
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

function kickoffLines(repo: string, participants: Participant[]): { id: string; line: string }[] {
  return participants
    .filter((participant) => participant.role !== 'human')
    .map((participant) => ({
      id: participant.id,
      line:
        participant.harness.startsWith('claude-code')
          ? `You are "${participant.id}" on Crosstalk. Your MCP server is configured in .mcp.json — call roster() to see who else is here, then await_turn().`
          : `You are "${participant.id}" on Crosstalk in ${resolve(repo)}. Use the CLI: \`ct await --as ${participant.id} --timeout 50\` to receive work, \`ct say --as ${participant.id} --room '#floor' --body '...'\` to speak.`,
    }));
}

function parseParticipants(specs: string[]): Participant[] {
  const participants: Participant[] = specs.map((spec) => {
    const [id, role, harness, model] = spec.split(':');
    if (!id || !role || !harness) {
      throw new CliError(
        `Cannot read participant "${spec}"`,
        EXIT.usage,
        'Use --participant id:role:harness[:model], for example --participant codex:worker:codex-app:luna-5.6',
      );
    }
    if (!['leader', 'worker', 'observer', 'human'].includes(role)) {
      throw new CliError(`Unknown role "${role}" in "${spec}"`, EXIT.usage, 'Roles: leader, worker, observer, human.');
    }
    return {
      id,
      role: role as Role,
      harness,
      ...(model === undefined ? {} : { model }),
      lifecycle: 'attached' as const,
      // The primary checkout is the leader's and no worker may occupy it.
      workspace: role === 'leader' ? '.' : join('.crosstalk', 'worktrees', id).replace(/\\/g, '/'),
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
