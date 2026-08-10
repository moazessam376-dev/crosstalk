import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../contracts/config.js';
import type { Participant, Role } from '../contracts/participant.js';
import { HUMAN_ID } from '../contracts/room.js';
import { distPath } from '../daemon/paths.js';
import { tokenFilename } from '../daemon/server.js';
import { CliError, EXIT, stateDir } from './client.js';

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

  const mcpPath = await writeMcpConfig(repo, participants, tokens);
  await ensureGitignored(repo);

  return { configPath, mcpPath, tokens, config, kickoff: kickoffLines(repo, participants) };
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

/** Tokens must never be committable. */
async function ensureGitignored(repo: string): Promise<void> {
  const path = join(repo, '.gitignore');
  const current = await readFile(path, 'utf8').catch(() => '');
  if (/^\.crosstalk\/?$/m.test(current) || /^\.crosstalk\/tokens\/?$/m.test(current)) return;

  const addition = `${current.endsWith('\n') || current === '' ? '' : '\n'}\n# Crosstalk runtime state — tokens live here and must never be committed\n.crosstalk/\n`;
  await writeFile(path, current + addition, 'utf8');
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
