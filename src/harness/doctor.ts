import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  HUMAN_ID,
  PARTICIPANT_ID_PATTERN,
  TERMINAL_RUNGS,
  type CrosstalkConfig,
  type Participant,
} from '../contracts/index.js';
import { headSha, gitVersion, isRepo } from '../workspace/git.js';
import { briefVersion, renderBrief } from './brief.js';
import { loadRegistry, probeTier, type HarnessDescriptor } from './registry.js';

const execFile = promisify(execFileCallback);

export interface Finding {
  level: 'reject' | 'warn';
  code: string;
  message: string;
  remedy: string;
}

function finding(level: Finding['level'], code: string, message: string, remedy: string): Finding {
  return { level, code, message, remedy };
}

function isWithin(parent: string, target: string): boolean {
  const child = relative(parent, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function parseGitVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^git version (\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function nodePrerequisite(): Finding | undefined {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= 20) return undefined;
  return finding(
    'reject',
    'NODE_TOO_OLD',
    `Node.js ${process.versions.node} is too old; Crosstalk requires Node.js 20 or newer.`,
    'Install Node.js 20 or newer from https://nodejs.org and reopen your terminal.',
  );
}

async function gitPrerequisite(cwd: string): Promise<Finding | undefined> {
  let version: string;
  try {
    version = await gitVersion(cwd);
  } catch {
    return finding(
      'reject',
      'GIT_UNAVAILABLE',
      'git not found on PATH.',
      'Install Git from https://git-scm.com and reopen your terminal.',
    );
  }

  const parsed = parseGitVersion(version);
  if (parsed === undefined || parsed.major < 2 || (parsed.major === 2 && parsed.minor < 5)) {
    return finding(
      'reject',
      'GIT_TOO_OLD',
      `${version} is too old; Crosstalk requires git 2.5 or newer.`,
      'Install git 2.5 or newer from https://git-scm.com and reopen your terminal.',
    );
  }
  return undefined;
}

async function repositoryPrerequisite(repoRoot: string): Promise<Finding | undefined> {
  if (!(await isRepo(repoRoot))) {
    return finding(
      'reject',
      'REPOSITORY_UNAVAILABLE',
      `No git repository with a work tree was found at ${repoRoot}.`,
      'Clone or initialize a git repository at the configured project path before running Crosstalk.',
    );
  }

  try {
    await headSha(repoRoot);
  } catch {
    return finding(
      'reject',
      'REPOSITORY_NO_COMMIT',
      'The git repository has no commit to anchor branches and evidence.',
      'Create an initial commit in the repository before running Crosstalk.',
    );
  }
  return undefined;
}

function configuredAgentCount(config: CrosstalkConfig): number {
  return config.participants.filter((participant) => participant.role !== 'human').length;
}

function duplicateParticipantIds(participants: Participant[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const participant of participants) {
    const normalized = participant.id.toLowerCase();
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  return duplicates;
}

async function writableBriefPath(filePath: string, repoRoot: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK | constants.W_OK);
    return true;
  } catch {
    // A new brief is valid when its nearest existing parent can be written.
  }

  let current = dirname(filePath);
  while (isWithin(repoRoot, current)) {
    try {
      await access(current, constants.F_OK | constants.W_OK);
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return false;
}

async function originConfigured(repoRoot: string): Promise<boolean> {
  try {
    await execFile('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
    : [''];

  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || '.', `${name}${extension}`);
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        // Keep looking on PATH.
      }
    }
  }
  return undefined;
}

type GithubCredentialStatus = 'configured' | 'missing' | 'unknown';

function isWindowsShellShim(executable: string): boolean {
  const lower = executable.toLowerCase();
  return process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'));
}

function isWindowsShellShimWithSpaces(executable: string): boolean {
  return isWindowsShellShim(executable) && executable.includes(' ');
}

async function githubCredentialStatus(cwd: string): Promise<GithubCredentialStatus> {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return 'configured';
  const gh = await findExecutable('gh');
  if (gh === undefined) return 'missing';
  if (isWindowsShellShimWithSpaces(gh)) return 'unknown';
  try {
    await execFile(gh, ['auth', 'status'], {
      cwd,
      shell: isWindowsShellShim(gh),
      windowsHide: true,
    });
    return 'configured';
  } catch {
    return 'missing';
  }
}

async function checkPrerequisites(
  config: CrosstalkConfig,
  cwd: string,
  repoRoot: string,
): Promise<Finding | undefined> {
  const nodeFinding = nodePrerequisite();
  if (nodeFinding !== undefined) return nodeFinding;

  const gitFinding = await gitPrerequisite(cwd);
  if (gitFinding !== undefined) return gitFinding;

  const repositoryFinding = await repositoryPrerequisite(repoRoot);
  if (repositoryFinding !== undefined) return repositoryFinding;

  if (configuredAgentCount(config) === 0) {
    return finding(
      'reject',
      'NO_HARNESS',
      'No agent harness is configured; Crosstalk has nobody to run.',
      'Install and sign in to at least one supported agent harness, then add it as a non-human participant.',
    );
  }

  return undefined;
}

async function checkParticipant(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: CrosstalkConfig['policy'],
  tier: 'mcp' | 'shell' | 'file',
  repoRoot: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const workspace = resolve(repoRoot, participant.workspace);
  if (participant.role === 'worker' && workspace === repoRoot) {
    findings.push(finding(
      'reject',
      'WORKER_IN_REPO_ROOT',
      `Worker ${participant.id} resolves to the repository root, which belongs to the leader.`,
      'Give every worker its own repo-relative git worktree under .crosstalk/worktrees/<id>.',
    ));
    return findings;
  }

  if (!isWithin(repoRoot, workspace)) {
    findings.push(finding(
      'reject',
      'WORKSPACE_OUTSIDE_REPO',
      `Participant ${participant.id} workspace resolves outside the repository: ${workspace}.`,
      'Set the participant workspace to a repo-relative path under the configured repository.',
    ));
    return findings;
  }

  const briefPath = resolve(workspace, descriptor.briefFile);
  if (!isWithin(workspace, briefPath)) {
    findings.push(finding(
      'reject',
      'BRIEF_OUTSIDE_WORKSPACE',
      `Harness ${descriptor.key} briefFile resolves outside participant ${participant.id}'s workspace.`,
      'Set briefFile to a path inside the participant workspace so Crosstalk cannot overwrite unrelated files.',
    ));
    return findings;
  }

  if (!(await writableBriefPath(briefPath, repoRoot))) {
    findings.push(finding(
      'reject',
      'BRIEF_UNWRITABLE',
      `The brief file for participant ${participant.id} is not writable: ${briefPath}.`,
      'Make the brief file or its containing directory writable so Crosstalk can regenerate the role brief.',
    ));
  }

  let actual: string | undefined;
  try {
    actual = await readFile(briefPath, 'utf8');
  } catch {
    // A missing file is reported by the same stale-brief warning as a hand edit.
  }
  const expected = renderBrief(participant, descriptor, policy, tier);
  if (actual === undefined || actual.replaceAll('\r\n', '\n') !== expected) {
    findings.push(finding(
      'warn',
      'BRIEF_STALE',
      `The brief for participant ${participant.id} is missing, stale, or hand-edited.`,
      `Regenerate ${descriptor.briefFile} with crosstalk init or writeBrief using the active policy and ${tier} tier.`,
    ));
  } else if (briefVersion(actual) !== briefVersion(expected)) {
    findings.push(finding(
      'warn',
      'BRIEF_STALE',
      `The version hash in the brief for participant ${participant.id} is stale.`,
      `Regenerate ${descriptor.briefFile} with crosstalk init or writeBrief using the active policy and ${tier} tier.`,
    ));
  }

  return findings;
}

export async function doctor(config: CrosstalkConfig, cwd: string): Promise<Finding[]> {
  const repoRoot = resolve(cwd, config.project.repo);
  const prerequisite = await checkPrerequisites(config, cwd, repoRoot);
  if (prerequisite !== undefined) return [prerequisite];

  let registry: Map<string, HarnessDescriptor>;
  try {
    registry = await loadRegistry();
  } catch {
    return [finding(
      'reject',
      'HARNESS_REGISTRY_UNAVAILABLE',
      'The built-in harness registry could not be loaded.',
      'Restore the packaged harnesses.yaml file and reinstall Crosstalk so at least one harness can be probed.',
    )];
  }

  const findings: Finding[] = [];
  const leaders = config.participants.filter((participant) => participant.role === 'leader');
  if (leaders.length !== 1) {
    findings.push(finding(
      'reject',
      'LEADER_COUNT',
      `Expected exactly one leader participant, found ${leaders.length}.`,
      'Configure exactly one participant with role: leader; all other agents should be workers or observers.',
    ));
  }

  const duplicates = duplicateParticipantIds(config.participants);
  if (duplicates.size > 0) {
    findings.push(finding(
      'reject',
      'DUPLICATE_PARTICIPANT_ID',
      `Participant ids must be unique case-insensitively; duplicates: ${[...duplicates].join(', ')}.`,
      'Rename each participant so its id is unique on case-insensitive filesystems.',
    ));
  }

  for (const participant of config.participants) {
    // `@human` is exempt: the pattern exists because a participant id becomes a
    // worktree directory name, and the human never gets a worktree. The *id* is
    // exempt, not the role — a second participant claiming `human` under a
    // worktree-unsafe id is still rejected.
    //
    // Without this, `crosstalk init` wrote a config that `crosstalk doctor`
    // rejected on the very next command: the product's first two steps
    // disagreeing about a file one of them had just generated. Raised by Track G
    // from the real run. No test covered the id `init` actually writes.
    if (participant.id === HUMAN_ID) continue;

    if (!PARTICIPANT_ID_PATTERN.test(participant.id)) {
      findings.push(finding(
        'reject',
        'INVALID_PARTICIPANT_ID',
        `Participant id ${participant.id} cannot safely be used as a worktree directory name.`,
        'Use 1-24 lowercase letters, digits, or hyphens, starting with a letter or digit.',
      ));
    }
  }

  const workers = config.participants.filter((participant) => participant.role === 'worker');
  if (workers.length < 2) {
    findings.push(finding(
      'warn',
      'THIRD_AGENT_UNAVAILABLE',
      `Only ${workers.length} worker is configured; the third_agent dispute rung will be skipped.`,
      'Add a second worker for third_agent adjudication, or choose a ladder that does not rely on that rung.',
    ));
  }

  const lastRung = config.policy.dispute.ladder.at(-1);
  if (lastRung === undefined || !TERMINAL_RUNGS.some((rung) => rung === lastRung)) {
    findings.push(finding(
      'reject',
      'NON_TERMINAL_LADDER',
      'The dispute ladder must end on a terminal rung.',
      'End the ladder with leader, human, or vote so every dispute can resolve without falling off the ladder.',
    ));
  } else if (config.policy.dispute.rungTimeouts[lastRung] !== undefined) {
    // The last rung never arms a timer — there is nothing to advance to, and a
    // dispute that timed out there would fall off the ladder unresolved. A
    // timeout configured on it is dead config that reads as a working
    // escalation, which is worse than no setting at all. Track A's C-2.
    //
    // Only the *last* rung: the shipped default sets `human: '4h'` while
    // ending on `leader`, and that timeout is live.
    findings.push(finding(
      'reject',
      'TERMINAL_RUNG_TIMEOUT',
      `The dispute ladder ends on ${lastRung}, but rungTimeouts.${lastRung} is set to ${config.policy.dispute.rungTimeouts[lastRung]}. The last rung never times out.`,
      `Remove rungTimeouts.${lastRung}, or add a rung after it if you meant the dispute to escalate further.`,
    ));
  }

  for (const participant of config.participants) {
    // `@human` runs no harness — the human participates through the hub in a
    // browser. `init` writes `harness: human` because the type requires the
    // field, and no registry entry exists or should.
    //
    // Same first-run failure as the id check above, found the same way and
    // missed once because it sat below a `head -20` in the leader's own
    // terminal: `crosstalk init` wrote a config that `crosstalk doctor`
    // rejected on the next command.
    if (participant.id === HUMAN_ID) continue;

    const descriptor = registry.get(participant.harness);
    if (descriptor === undefined) {
      findings.push(finding(
        'reject',
        'UNKNOWN_HARNESS',
        `Participant ${participant.id} references unknown harness ${participant.harness}.`,
        'Choose a harness key from the bundled registry or add its descriptor before starting Crosstalk.',
      ));
      continue;
    }

    if (participant.lifecycle === 'supervised' && !descriptor.supervisable) {
      findings.push(finding(
        'reject',
        'SUPERVISED_GUI_HARNESS',
        `Participant ${participant.id} uses supervised lifecycle with GUI harness ${descriptor.key}.`,
        'Use a CLI harness for supervised lifecycle, or change this participant to attached lifecycle.',
      ));
    }

    let tier = participant.transport;
    if (tier === undefined) {
      tier = await probeTier(descriptor, resolve(repoRoot, participant.workspace));
      if (descriptor.mcp !== 'none' && tier !== 'mcp') {
        findings.push(finding(
          'warn',
          'MCP_PROBE_FALLBACK',
          `MCP probe failed for ${participant.id}; falling back to ${tier} tier.`,
          `Register an accepted MCP configuration for ${descriptor.key}, or keep the ${tier} tier and use its transport instructions.`,
        ));
      }
    }

    findings.push(...await checkParticipant(participant, descriptor, config.policy, tier, repoRoot));
  }

  if (config.mirror?.github.enabled) {
    if (!(await originConfigured(repoRoot))) {
      findings.push(finding(
        'warn',
        'MIRROR_NO_REMOTE',
        'GitHub mirroring is enabled but no origin remote is configured.',
        'Add a GitHub origin remote or disable mirror.github.enabled; the local protocol will continue without mirroring.',
      ));
    }
    const credentialStatus = await githubCredentialStatus(repoRoot);
    if (credentialStatus === 'missing') {
      findings.push(finding(
        'warn',
        'MIRROR_NO_CREDENTIAL',
        'GitHub mirroring is enabled but no GITHUB_TOKEN or GH_TOKEN is configured.',
        'Authenticate the gh CLI or set GITHUB_TOKEN/GH_TOKEN; otherwise disable mirroring and use the local protocol.',
      ));
    } else if (credentialStatus === 'unknown') {
      findings.push(finding(
        'warn',
        'MIRROR_CREDENTIAL_UNKNOWN',
        'GitHub mirroring is enabled but the gh CLI credential could not be verified because its Windows command shim path contains spaces.',
        'Set GITHUB_TOKEN/GH_TOKEN or use a gh.exe installation on PATH; otherwise disable mirroring and use the local protocol.',
      ));
    }
  }

  return findings;
}
