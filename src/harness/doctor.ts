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
import { branchSha, headSha, gitVersion, isAncestor, isRepo, samePath } from '../workspace/git.js';
import { prefixesOverlap } from '../workspace/ownership.js';
import { briefPathFor, briefVersion, renderBrief } from './brief.js';
import { linkedInstallRoot, packageRootFromModule } from './install.js';
import { loadRegistry, probeTier, type HarnessDescriptor } from './registry.js';

const execFile = promisify(execFileCallback);

/** Reserved like `@human`: it already names the MCP server entry and the tool. */
const RESERVED_PARTICIPANT_ID = 'crosstalk';

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

/**
 * Pairs of participants whose declared prefixes contain one another.
 *
 * This is the check the shared-root permission rests on. Each of two workers
 * owning `src/` and `src/metrics/` passes its own submit gate — every file it
 * touches is inside its own declaration — while both write the same files. The
 * only place that can be caught is here, across the whole roster, before either
 * of them starts.
 */
function overlappingOwnership(participants: Participant[]): string[] {
  const declared = participants.filter((participant) => (participant.owns?.length ?? 0) > 0);
  const clashes: string[] = [];
  for (let left = 0; left < declared.length; left += 1) {
    for (let right = left + 1; right < declared.length; right += 1) {
      const one = declared[left]!;
      const other = declared[right]!;
      for (const mine of one.owns ?? []) {
        for (const theirs of other.owns ?? []) {
          if (prefixesOverlap(mine, theirs)) {
            clashes.push(`${one.id} (${mine}) and ${other.id} (${theirs})`);
          }
        }
      }
    }
  }
  return clashes;
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

function spocPolicyFindings(config: CrosstalkConfig): Finding[] {
  const found: Finding[] = [];
  const spocs = config.participants.filter((participant) => participant.role === 'spoc');
  if (spocs.length > 1) {
    found.push(finding(
      'reject',
      'SPOC_COUNT',
      `Expected at most one SPOC participant, found ${spocs.length}.`,
      'Keep a single participant with role: spoc. Acceptance is one seat.',
    ));
  }

  const acceptance = config.policy.taskAcceptance;
  if (acceptance.method !== 'spoc') return found;

  const delegate = acceptance.delegate;
  if (delegate === undefined || delegate === '') {
    found.push(finding(
      'reject',
      'SPOC_DELEGATE_MISSING',
      'policy.taskAcceptance.method is "spoc" but no delegate is named.',
      'Set taskAcceptance.delegate to the SPOC participant id.',
    ));
    return found;
  }

  const named = config.participants.find((participant) => participant.id === delegate);
  if (named === undefined) {
    found.push(finding(
      'reject',
      'SPOC_DELEGATE_UNKNOWN',
      `taskAcceptance.delegate "${delegate}" is not a participant.`,
      'Name a participant that exists on the roster.',
    ));
    return found;
  }

  if (named.role === 'leader') {
    found.push(finding(
      'reject',
      'SPOC_IS_LEADER',
      `taskAcceptance.delegate "${delegate}" is the leader. SPOC and leader must not be the same seat.`,
      'Give SPOC its own participant. The leader plans; SPOC accepts.',
    ));
  } else if (named.role !== 'spoc') {
    found.push(finding(
      'reject',
      'SPOC_DELEGATE_WRONG_ROLE',
      `taskAcceptance.delegate "${delegate}" has role ${named.role}, not spoc.`,
      'Set that participant\'s role to spoc, or point delegate at the SPOC.',
    ));
  }

  return found;
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

/**
 * Why a harness is not on the mcp tier — the declared transport first.
 *
 * `mcp: 'unverified'` was a dead field: the path guard always fired ahead of
 * it, so the declared value could never be the reported reason for any harness.
 */
function mcpUnavailableBecause(descriptor: HarnessDescriptor): string {
  if (descriptor.mcp !== 'stdio') return `${descriptor.key} declares mcp: ${descriptor.mcp}, which Crosstalk cannot drive`;
  if (descriptor.mcpConfigPath === undefined) return `${descriptor.key} names no MCP configuration path`;
  return `${descriptor.mcpConfigPath} is outside the workspace, so Crosstalk does not write it`;
}

/**
 * CT-1. Exported so the rule can be exercised with both roots supplied, rather
 * than only on a machine that happens to have a divergent global install.
 */
export async function installSkewFinding(
  running: string,
  linked: string | undefined,
): Promise<Finding | undefined> {
  if (linked === undefined) return undefined;
  if (await samePath(running, linked)) return undefined;

  return finding(
    'warn',
    'CLI_INSTALL_SKEW',
    `\`crosstalk\` on PATH resolves to ${linked}, but this command is running from ${running}. Agents that follow a kickoff line would run a different build than the one that wrote this project.`,
    `Run the CLI from one install — \`npm link\` in ${running}, or invoke it by absolute path — so every participant speaks the same build.`,
  );
}

async function checkInstallSkew(): Promise<Finding[]> {
  const skew = await installSkewFinding(
    packageRootFromModule(import.meta.url),
    await linkedInstallRoot().catch(() => undefined),
  );
  return skew === undefined ? [] : [skew];
}

export async function checkPrerequisites(
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

/**
 * Worker worktrees that exist but sit behind the main branch.
 *
 * Silent about anything it cannot determine: a workspace that is not a checkout
 * yet, a main branch this clone does not have, a git that refuses. `doctor` is
 * read-only advice, and a warning produced by a failed measurement is worse than
 * no warning at all.
 *
 * One finding for all of them, like the model check — the operator had three at
 * once, and three lines saying the same thing is a wall, not a report.
 */
async function checkWorktreeFreshness(
  config: CrosstalkConfig,
  repoRoot: string,
): Promise<Finding[]> {
  const workers = config.participants.filter((participant) => participant.role === 'worker');
  if (workers.length === 0) return [];

  let mainSha: string;
  try {
    mainSha = await branchSha(repoRoot, config.project.mainBranch);
  } catch {
    return [];
  }

  const behind: string[] = [];
  for (const participant of workers) {
    const workspace = resolve(repoRoot, participant.workspace);
    if (workspace === repoRoot) continue;
    try {
      const head = await headSha(workspace);
      // Behind, not merely different: a worktree carrying commits of its own is
      // ahead or diverged, and telling someone doing work that they are "behind"
      // would be both wrong and annoying.
      if (head !== mainSha && (await isAncestor(head, mainSha, repoRoot))) behind.push(participant.id);
    } catch {
      // Not a checkout, or not readable. Not something to report as staleness.
    }
  }
  if (behind.length === 0) return [];

  return [finding(
    'warn',
    'WORKTREE_BEHIND_MAIN',
    `The worktree for ${behind.join(', ')} is behind ${config.project.mainBranch}, so that agent is reading older code than the leader.`,
    `Run \`git merge --ff-only ${config.project.mainBranch}\` in each of those worktrees, or \`crosstalk down --purge\` and \`crosstalk init\` to rebuild them.`,
  )];
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
    // CT-20. This was an unconditional reject, and it is why every agent needed
    // its own worktree — and therefore why one Crosstalk project rendered as one
    // top-level project entry *per agent* in the harness's sidebar.
    //
    // What made shared root unsafe was never identity: `.crosstalk/tokens/` sits
    // at the repository root and every worktree can already read every token, so
    // worktrees gave write isolation and never identity isolation. It is the
    // writes that need a boundary, and a declared one is checkable where a
    // worktree boundary was merely structural.
    //
    // So the reject becomes conditional on the declaration rather than
    // disappearing: no `owns`, no shared root. An empty list counts as absent —
    // it declares nothing while looking declared, and `outsideOwnership` treats
    // it as owning nothing, so a submit would refuse every file anyway.
    if (participant.owns === undefined || participant.owns.length === 0) {
      findings.push(finding(
        'reject',
        'WORKER_IN_ROOT_WITHOUT_OWNERSHIP',
        `Worker ${participant.id} resolves to the repository root without declaring any owned paths.`,
        'Add `owns:` listing the repo-relative directories this worker may write, for example `owns: [src/metrics/]`, or give it its own worktree under .crosstalk/worktrees/<id>.',
      ));
      return findings;
    }
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

  // CT-4: the brief lives at the untracked local path, never the tracked one.
  // CT-20: and is named for its participant when several share the root, so
  // `briefPathFor` rather than `localBriefFile` — `init` writes through the
  // same function, and the two computing it differently would be a permanent
  // BRIEF_STALE on a brief that is correct.
  const briefFile = briefPathFor(participant, descriptor.briefFile, repoRoot);
  const briefPath = resolve(workspace, briefFile);
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
  // The same `repoRoot` `writeBrief` was given. The brief now names the
  // workspace absolutely, and this comparison is byte-for-byte — passing a
  // different root here would put BRIEF_STALE on every participant, on every
  // `doctor` and every `up` preflight.
  const expected = renderBrief(participant, descriptor, policy, tier, repoRoot);
  if (actual === undefined || actual.replaceAll('\r\n', '\n') !== expected) {
    findings.push(finding(
      'warn',
      'BRIEF_STALE',
      `The brief for participant ${participant.id} is missing, stale, or hand-edited.`,
      `Regenerate ${briefFile} with crosstalk init or writeBrief using the active policy and ${tier} tier.`,
    ));
  } else if (briefVersion(actual) !== briefVersion(expected)) {
    findings.push(finding(
      'warn',
      'BRIEF_STALE',
      `The version hash in the brief for participant ${participant.id} is stale.`,
      `Regenerate ${briefFile} with crosstalk init or writeBrief using the active policy and ${tier} tier.`,
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

  const clashes = overlappingOwnership(config.participants);
  if (clashes.length > 0) {
    findings.push(finding(
      'reject',
      'OWNERSHIP_OVERLAP',
      `Declared ownership overlaps, so these participants can overwrite each other: ${clashes.join('; ')}.`,
      'Narrow one of each pair so no declared prefix contains another. Sibling directories do not overlap; a parent and its child do.',
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

    // `crosstalk` is reserved for the same reason `human` is: it already names
    // something. Registrations are now keyed `mcpServers.crosstalk-<id>`, so
    // the collision is no longer exact — but the name is still the product's,
    // and a participant called `crosstalk` produces a worktree, a token file
    // and a `crosstalk-crosstalk` server that read as the tool rather than as
    // an agent.
    if (participant.id.toLowerCase() === RESERVED_PARTICIPANT_ID) {
      findings.push(finding(
        'reject',
        'RESERVED_PARTICIPANT_ID',
        `Participant id "${participant.id}" is reserved by Crosstalk itself.`,
        'Rename that participant. `crosstalk` names the MCP server entry and the tool; an agent cannot also hold it.',
      ));
    }
  }

  // C-15. `policy.taskAcceptance.method` is read when a task reaches
  // `accepted`, and only `leader` and `human` resolve to an authority. A
  // `majority` or `unanimous` setting parses, validates, and then refuses every
  // acceptance with NOT_TASK_AUTHORITY naming a decision route that nothing
  // opens — so the task sits in `submitted` forever and the log says only that
  // somebody was not authorised. Stranding a task silently is worse than
  // refusing the config that would strand it.
  const acceptance = config.policy.taskAcceptance.method;
  if (acceptance === 'majority' || acceptance === 'unanimous') {
    findings.push(finding(
      'reject',
      'TASK_ACCEPTANCE_UNIMPLEMENTED',
      `policy.taskAcceptance.method is "${acceptance}", which is not implemented; no task could ever be accepted.`,
      'Use leader or human. A vote-based acceptance needs a decision route that does not exist yet.',
    ));
  }

  findings.push(...spocPolicyFindings(config));

  findings.push(...await checkInstallSkew());

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
          `${participant.id} runs at the ${tier} tier: ${mcpUnavailableBecause(descriptor)}.`,
          // The old remedy said "register an accepted MCP configuration",
          // which cannot be followed when the harness names no path to
          // register into and nothing would read one. A remedy you cannot act
          // on reads as a fault you caused.
          descriptor.mcpConfigPath === undefined
            ? `Nothing to do — ${descriptor.key} has no MCP configuration path. The ${tier} tier is how it participates.`
            : `Expected — ${descriptor.mcpConfigPath} is outside this repository, so Crosstalk prints the registration instead of writing it. Add it by hand to use MCP.`,
        ));
      }
    }

    findings.push(...await checkParticipant(participant, descriptor, config.policy, tier, repoRoot));
  }

  // CT-17. `init` accepts `--participant id:role:harness[:model[:effort]]` and the hub
  // renders the model when it is there, but nothing prompts for one and nothing
  // said it was missing — so the default outcome was the uninformative one.
  //
  // One finding naming every participant, not one each: a default `init`
  // already emits two warnings and `up` prints them above the banner, and a
  // correct first run should not read as a fault report.
  //
  // Worth stating in the remedy and not only here: this is hand-declared and
  // unverified. Nothing checks that the agent claiming a model is running it,
  // so it is documentation rather than fact.
  const unnamed = config.participants
    .filter((participant) => participant.role !== 'human' && participant.model === undefined)
    .map((participant) => participant.id);
  if (unnamed.length > 0) {
    findings.push(finding(
      'warn',
      'PARTICIPANT_NO_MODEL',
      `No model is declared for ${unnamed.join(', ')}, so the hub cannot show which model each agent is running.`,
      'Re-run init with --participant id:role:harness:model[:effort], or add `model:` to those participants in crosstalk.yaml. `effort:` sits beside it and the hub shows the pair. Both are hand-declared and unverified — nothing checks the agent is running what it claims.',
    ));
  }

  // The half `init` cannot see. `init` inspects a base branch whose worktree is
  // gone; a worktree that exists, is registered, and has simply fallen behind is
  // the ordinary daily case — an agent that has not rebased — and nothing looked
  // at it. On the machine where CT-12 was found the operator fixed three of them
  // by hand with `git merge --ff-only main`.
  findings.push(...await checkWorktreeFreshness(config, repoRoot));

  // CT-19. `src/mirror/` exists and `doctor` checks it, but `init` writes no
  // mirror key, so the only way to turn it on is hand-editing an undocumented
  // shape. That is a legitimate not-yet-built; the defect is that nothing said
  // so, leaving an unbuilt feature and a deliberately disabled one identical.
  if (config.mirror === undefined) {
    findings.push(finding(
      'warn',
      'MIRROR_UNCONFIGURED',
      'No GitHub mirror is configured, and init does not yet write one.',
      'Expected — v1 ships the protocol and the mirror follows. Everything works locally without it. To try it, add a mirror.github block to crosstalk.yaml by hand.',
    ));
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
