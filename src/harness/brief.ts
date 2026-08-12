import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync as readFileSyncFromFs } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { PolicyConfig, Participant, Tier } from '../contracts/index.js';
import type { HarnessDescriptor } from './registry.js';

const VERSION_PLACEHOLDER = '<!-- crosstalk brief version: {{briefVersion}} -->';
const VERSION_MARKER = /<!-- crosstalk brief version: ct-brief-[0-9a-f]{8} -->/g;
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function readTemplate(name: 'leader' | 'worker'): string {
  const candidates = [
    new URL(`./templates/${name}.md`, import.meta.url),
    new URL(`../../src/harness/templates/${name}.md`, import.meta.url),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return readFileSyncFromFs(candidate, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to load ${name} brief template`);
}

function replaceTokens(template: string, tokens: Record<string, string>): string {
  const rendered = template.replace(TOKEN, (whole, key: string) => {
    if (!(key in tokens)) throw new Error(`Unknown brief template token: ${key}`);
    const value = tokens[key];
    if (value === undefined) throw new Error(`Missing brief template token: ${key}`);
    return value;
  });
  if (rendered.replaceAll('{{briefVersion}}', '').includes('{{')) {
    throw new Error('Brief template contains an unresolved token');
  }
  return rendered;
}

function policySummary(policy: PolicyConfig): string {
  const rungTimeouts = Object.keys(policy.dispute.rungTimeouts)
    .sort()
    .map((rung) => `${rung}: ${policy.dispute.rungTimeouts[rung as keyof typeof policy.dispute.rungTimeouts]}`)
    .join(', ');

  return [
    `- Self-critique required: ${policy.selfCritique.required}; minimum rounds: ${policy.selfCritique.minRounds}`,
    `- Leader critique maximum rounds: ${policy.leaderCritique.maxRounds}`,
    `- Dispute maximum rounds: ${policy.dispute.maxRounds}`,
    `- Dispute ladder: ${policy.dispute.ladder.join(' -> ')}`,
    `- Rung timeouts: ${rungTimeouts || 'none'}`,
    `- Task acceptance method: ${policy.taskAcceptance.method}`,
  ].join('\n');
}

function transportInstructions(tier: Tier): string {
  // Every name below is checked against the real CLI command table and the real
  // MCP tool list by `tests/harness/brief-vocabulary.test.ts`. This block named
  // four commands of which two did not exist — `acknowledge` and `submit` on
  // the shell tier, `acknowledge()` and `submit()` on MCP — and it survived a
  // full protocol repair because nothing compared it to the code. It is the
  // first thing every agent reads.
  if (tier === 'mcp') {
    return [
      'Use the registered MCP tools against the Crosstalk daemon.',
      '- `ack_task(task_id, restatement, ambiguities[])` is the gate before code.',
      '- `raise_claim({...})` requires assertion, severity, falsifier, and evidence.',
      '- `respond_to_claim(claim_id, verdict, ...)` records accept, contest, or clarify.',
      '- `submit_task(task_id, critique, evidence[])` is the self-critique gate.',
    ].join('\n');
  }

  if (tier === 'shell') {
    return [
      'Use the Crosstalk shell CLI; validation failures are reported by exit code.',
      '- `crosstalk claim --as ID --against leader --target src/file.ts:1 --assertion "..." --falsifier "..."`',
      '- `crosstalk respond CLAIM_ID --as ID --verdict contest --rationale "..." --falsifier "..."`',
      '- `crosstalk await --as ID --timeout 50` blocks until there is a turn for you.',
      '- `crosstalk mine --as ID` lists the tasks you hold; `crosstalk board` shows all of them.',
      '- `crosstalk task state ID --as ID --state in_progress` moves a task you hold.',
      '- Leaders only: `crosstalk task create --as ID --id T-01 --title "..." --brief "..." --assignee ID --branch B`.',
      'The task gates — acknowledging a brief and submitting a self-critique — are MCP tools only.',
      'There is no CLI command for them yet; say so in `#floor` rather than inventing one.',
    ].join('\n');
  }

  return [
    'Use the Crosstalk file inbox/outbox format; each action is one fenced crosstalk block.',
    'Write the same payload fields required by the protocol validator, including a falsifier.',
    'Read the rendered inbox response after each action and correct rejected blocks there.',
  ].join('\n');
}

/**
 * The rules that depend on whether this agent has a checkout to itself.
 *
 * Two layouts, two different things to say, and saying the wrong one is
 * actively harmful: telling a shared-root agent "the repository root belongs to
 * someone else" contradicts where it is standing, and telling a worktree agent
 * it owns three prefixes invents a restriction nobody configured.
 *
 * For shared root, both facts are conventions rather than enforcement, which is
 * exactly why they must be stated. Every participant's MCP server is visible in
 * the one root `.mcp.json`, so an agent calling the wrong namespace posts as
 * someone else and the daemon accepts it — holding a token *is* the identity.
 * And ownership is only checked at submit, so an agent that discovers its
 * boundary there has already done the work twice.
 */
function workspaceRules(participant: Participant): string {
  const owns = participant.owns ?? [];
  if (owns.length === 0) {
    // CT-13. The one that sent a Cursor session walking to the repository root
    // twice on startup, correctly following its brief.
    return 'That checkout is yours alone — it is not the leader\'s, and the repository root belongs to someone else.';
  }

  return [
    '## Your identity and your paths',
    '',
    `Every agent on this project shares this one directory, so your MCP server is`,
    `one of several registered here. Yours is \`crosstalk-${participant.id}\` — call`,
    'its tools and no others. Confirm it before anything else: `roster()` returns',
    `\`you\`, and it must read \`${participant.id}\`. If it does not, stop and say so in`,
    '`#floor`; you are holding somebody else\'s token and everything you write will',
    'be attributed to them.',
    '',
    'These are the paths you own, and the only ones you may write:',
    '',
    ...owns.map((prefix) => `- \`${prefix}\``),
    '',
    'A submit that touches anything outside them is refused whole — not trimmed to',
    'the part that fits — so check before you write rather than after. If the work',
    'genuinely needs a path you do not own, raise a claim instead of taking it.',
    '',
  ].join('\n');
}

function canonicalContent(content: string): string {
  return content.replaceAll('\r\n', '\n').replace(VERSION_MARKER, VERSION_PLACEHOLDER);
}

export function briefVersion(content: string): string {
  const digest = createHash('sha256').update(canonicalContent(content), 'utf8').digest('hex').slice(0, 8);
  return `ct-brief-${digest}`;
}

/**
 * @param repo  The repository root, so the brief can name the participant's
 *   workspace absolutely. CT-13: the brief said "your workspace is
 *   `.crosstalk/worktrees/binding`" — repo-relative, which is the right thing to
 *   store in `crosstalk.yaml` and the wrong thing to hand an agent standing in
 *   it. From inside the workspace that path does not resolve, and the only
 *   directory where it does is the repository root: the leader's workspace, and
 *   the identity collision CT-8/CT-9 are about. The Cursor session tried to walk
 *   there twice on startup, correctly following its brief.
 *
 *   Required rather than defaulted. `doctor` renders the expected brief and
 *   compares it byte-for-byte against what is on disk, so a caller that forgot
 *   to pass this would put `BRIEF_STALE` on every participant on every `doctor`
 *   and every `up` preflight. A required parameter fails at compile time
 *   instead.
 */
export function renderBrief(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: PolicyConfig,
  tier: Tier,
  repo: string,
): string {
  const template = readTemplate(participant.role === 'leader' ? 'leader' : 'worker');
  const draft = replaceTokens(template, {
    briefVersion: '{{briefVersion}}',
    participantId: participant.id,
    harness: descriptor.key,
    workspace: participant.workspace,
    // The workspace root, never `dirname` of the brief file. `localBriefFile`
    // rewrites only the basename, but `cursor-*` declares a `briefFile` of
    // `.cursor/rules/crosstalk.mdc`, so the directory the brief lands in is two
    // levels below the workspace. Naming that would reproduce CT-13 for the one
    // harness that actually wandered.
    workspaceAbsolute: resolve(repo, participant.workspace),
    tier,
    lifecycle: participant.lifecycle,
    policySummary: policySummary(policy),
    transportInstructions: transportInstructions(tier),
    workspaceRules: workspaceRules(participant),
  });
  return draft.replaceAll('{{briefVersion}}', briefVersion(draft));
}

/**
 * Where a participant's brief is actually written.
 *
 * CT-4. Briefs went to `descriptor.briefFile` — `CLAUDE.md` for every
 * `claude-code-*` participant and `AGENTS.md` for every `codex-*` one. Those
 * are the project's canonical, *tracked* documents, and each worker's worktree
 * is the same tracked path. So a clean `init`, with no agent having run, left
 * every claude-code worker dirty:
 *
 *     --- skeleton ---
 *      M CLAUDE.md
 *     --- metrics ---
 *      M CLAUDE.md
 *
 * A worker that then commits with `git add -A` commits its own brief over the
 * leader's, and merging that to `main` replaces the project brief with a
 * worker brief.
 *
 * `.gitignore` cannot fix this, which is worth stating because it is the
 * obvious fix and it does not work: ignore rules have no effect on paths git
 * already tracks, and `.gitignore` is itself tracked, so writing to it is the
 * same class of change. The brief has to move to a path git was never
 * following — and `init` registers that path in `.git/info/exclude`, which is
 * per-clone and not tracked either.
 *
 * `CLAUDE.md` -> `CLAUDE.local.md`, matching the convention this repo already
 * uses for exactly this purpose.
 */
export function localBriefFile(briefFile: string): string {
  const extension = extname(briefFile);
  return extension === ''
    ? `${briefFile}.local`
    : `${briefFile.slice(0, -extension.length)}.local${extension}`;
}

export async function writeBrief(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: PolicyConfig,
  tier: Tier,
  repo: string,
): Promise<void> {
  const content = renderBrief(participant, descriptor, policy, tier, repo);
  const destination = resolve(repo, participant.workspace, localBriefFile(descriptor.briefFile));
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });

  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
