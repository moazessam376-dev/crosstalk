import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync as readFileSyncFromFs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  if (tier === 'mcp') {
    return [
      'Use the registered MCP tools against the Crosstalk daemon.',
      '- `acknowledge(task_id, restatement, ambiguities[])` is the gate before code.',
      '- `raise_claim({...})` requires assertion, severity, falsifier, and evidence.',
      '- `respond_to_claim(claim_id, verdict, ...)` records accept, contest, or clarify.',
      '- `submit(task_id, critique_record, evidence[])` is the self-critique gate.',
    ].join('\n');
  }

  if (tier === 'shell') {
    return [
      'Use the Crosstalk shell CLI; validation failures are reported by exit code.',
      '- `crosstalk acknowledge --task TASK_ID --restatement "..." --ambiguity "..."`',
      '- `crosstalk claim raise --against leader --target src/file.ts:1 --assertion "..." --falsifier "..."`',
      '- `crosstalk claim respond CLAIM_ID --verdict contest --rationale "..." --falsifier "..."`',
      '- `crosstalk submit --task TASK_ID --critique-file critique.json`',
    ].join('\n');
  }

  return [
    'Use the Crosstalk file inbox/outbox format; each action is one fenced crosstalk block.',
    'Write the same payload fields required by the protocol validator, including a falsifier.',
    'Read the rendered inbox response after each action and correct rejected blocks there.',
  ].join('\n');
}

function canonicalContent(content: string): string {
  return content.replaceAll('\r\n', '\n').replace(VERSION_MARKER, VERSION_PLACEHOLDER);
}

export function briefVersion(content: string): string {
  const digest = createHash('sha256').update(canonicalContent(content), 'utf8').digest('hex').slice(0, 8);
  return `ct-brief-${digest}`;
}

export function renderBrief(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: PolicyConfig,
  tier: Tier,
): string {
  const template = readTemplate(participant.role === 'leader' ? 'leader' : 'worker');
  const draft = replaceTokens(template, {
    briefVersion: '{{briefVersion}}',
    participantId: participant.id,
    harness: descriptor.key,
    workspace: participant.workspace,
    tier,
    lifecycle: participant.lifecycle,
    policySummary: policySummary(policy),
    transportInstructions: transportInstructions(tier),
  });
  return draft.replaceAll('{{briefVersion}}', briefVersion(draft));
}

export async function writeBrief(
  participant: Participant,
  descriptor: HarnessDescriptor,
  policy: PolicyConfig,
  tier: Tier,
  repo: string,
): Promise<void> {
  const content = renderBrief(participant, descriptor, policy, tier);
  const destination = resolve(repo, participant.workspace, descriptor.briefFile);
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
