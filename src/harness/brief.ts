import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync as readFileSyncFromFs } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { PolicyConfig, Participant, Tier } from '../contracts/index.js';
import type { HarnessDescriptor } from './registry.js';

const VERSION_PLACEHOLDER = '<!-- crosstalk brief version: {{briefVersion}} -->';
const VERSION_MARKER = /<!-- crosstalk brief version: ct-brief-[0-9a-f]{8} -->/g;
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function readTemplate(name: 'leader' | 'worker' | 'spoc' | 'peer'): string {
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
  const method = policy.taskAcceptance.method;
  if (method === 'spoc') {
    return `Acceptance is the SPOC's (${policy.taskAcceptance.delegate ?? 'unnamed'}). @human can override.`;
  }
  if (method === 'human') {
    return 'Acceptance is @human\'s.';
  }
  return '';
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
      'Call `inbox()` first. If `job` is set, that is the work. If next is idle, wait.',
      '`act({kind:"ack"|"assign"|"done"|"accept"|"reject"})` for tasks. `claim({kind})` only for contradictions.',
      'Confirm `inbox()` says `you` is you before you write.',
    ].join('\n');
  }

  if (tier === 'shell') {
    return [
      'Use the Crosstalk shell CLI; validation failures are reported by exit code.',
      '- `crosstalk inbox --as ID` returns cards now. Pass `--timeout 50` only to wait.',
      '- `crosstalk say --as ID --room \'#floor\' --body "..."`',
      '- `crosstalk act --as ID --kind ack --task T-01 --restatement "..."`',
      '- `crosstalk claim --as ID --against leader --target src/file.ts:1 --assertion "..." --falsifier "..."`',
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
    'its tools and no others. Confirm it before anything else: `inbox()` returns',
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
  const template = readTemplate(
    participant.role === 'leader'
      ? 'leader'
      : participant.role === 'spoc'
        ? 'spoc'
        : participant.role === 'peer'
          ? 'peer'
          : 'worker',
  );
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
 *
 * CT-20 adds the second half. `.local` alone is unique per *directory*, which
 * was enough while every participant had a worktree of its own. In a shared
 * root it is not: three `claude-code-app` participants all resolve to
 * `CLAUDE.local.md` in the same directory, so each brief overwrote the last and
 * two of the three agents read somebody else's instructions — including which
 * MCP namespace to use and which paths they own, the two facts shared root
 * depends on. `doctor` reported it as `BRIEF_STALE` on whichever two lost.
 *
 * So a participant that shares the root is named in its own filename. The
 * unshared case is left exactly as it was: renaming those would strand a
 * correct brief at the old path on every existing project.
 */
export function localBriefFile(briefFile: string, participantId?: string): string {
  const extension = extname(briefFile);
  const stem = extension === '' ? briefFile : briefFile.slice(0, -extension.length);
  const scope = participantId === undefined ? '' : `.${participantId}`;
  return `${stem}${scope}.local${extension}`;
}

/**
 * The brief path for a participant, scoped by id only when it shares the root.
 *
 * One place that decides, because `init` writes the file and `doctor` compares
 * against it: the two computing that path differently is a permanent
 * `BRIEF_STALE` on a brief that is perfectly correct.
 */
export function briefPathFor(
  participant: Participant,
  briefFile: string,
  repo: string,
): string {
  // The leader keeps the unscoped name, and not for neatness. Its workspace is
  // the repository root in *every* configuration, shared or not, so scoping it
  // would rename the leader's brief on every project that already exists and
  // leave the old file sitting beside the new one — a stale brief at the path
  // an operator would go and read. Workers are the only participants that can
  // newly arrive in the root, and there is exactly one leader, so scoping just
  // them is enough for the names to be unique.
  const shared = resolve(repo, participant.workspace) === resolve(repo);
  const scoped = shared && participant.role !== 'leader';
  return localBriefFile(briefFile, scoped ? participant.id : undefined);
}

export async function writeBrief(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: PolicyConfig,
  tier: Tier,
  repo: string,
): Promise<void> {
  const content = renderBrief(participant, descriptor, policy, tier, repo);
  const destination = resolve(repo, participant.workspace, briefPathFor(participant, descriptor.briefFile, repo));
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
