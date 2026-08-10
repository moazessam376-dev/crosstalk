import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface McpConfig {
  repo: string;
  token: string;
  url: string;
}

/**
 * The daemon binds an ephemeral port, and `.mcp.json` is written by
 * `crosstalk init` before any daemon exists. Pinning a port there would make
 * the two files disagree the first time anyone passes `--port`. So the URL is
 * discovered from a file the daemon already writes, not configured.
 *
 * Front-door interfaces §1.
 */
export interface DaemonDescriptor {
  version: number;
  url: string;
  pid: number;
  startedAt: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * `env` is a parameter rather than a read of `process.env` so a test can drive
 * this without mutating global state — three tests running in one worker
 * otherwise share one environment.
 */
export async function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  const repoRaw = env['CROSSTALK_REPO'];
  if (repoRaw === undefined || repoRaw.trim() === '') {
    throw new ConfigError(
      'CROSSTALK_REPO is not set. It is written into .mcp.json by `crosstalk init` — run that in the repository you want to join.',
    );
  }

  const token = env['CROSSTALK_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new ConfigError(
      'CROSSTALK_TOKEN is not set. Each participant has its own token — one shared token would make `from` self-asserted and the ledger unreadable.',
    );
  }

  const repo = resolve(repoRaw);
  return { repo, token, url: env['CROSSTALK_URL'] ?? (await discoverUrl(repo)) };
}

/**
 * A missing descriptor is not swallowed. An agent whose tools silently return
 * nothing is the failure this project keeps rediscovering, so the message names
 * the command that fixes it.
 */
export async function discoverUrl(repo: string): Promise<string> {
  const path = join(repo, '.crosstalk', 'daemon.json');

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(
      `No daemon is running for ${repo} — ${path} does not exist. Start one with \`crosstalk up\`, then retry.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${path} is not valid JSON. Stop the daemon with \`crosstalk down\` and start it again with \`crosstalk up\`.`,
    );
  }

  const url = (parsed as Partial<DaemonDescriptor> | null)?.url;
  if (typeof url !== 'string' || url === '') {
    throw new ConfigError(
      `${path} carries no \`url\`. Stop the daemon with \`crosstalk down\` and start it again with \`crosstalk up\`.`,
    );
  }

  return url;
}
