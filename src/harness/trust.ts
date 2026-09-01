import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pre-accepting the folder-trust dialog for a seat's workspace.
 *
 * An interactive Claude Code session opening a directory it has not seen asks
 * "Is this a project you created or one you trust?" and waits. A seat that
 * `crosstalk init` created a minute ago is always such a directory, so every
 * interactive run would stop dead at launch with nobody to answer — the exact
 * failure mode the operator asked to eliminate, arriving before the seat has
 * read a single line of its brief.
 *
 * The alternative was to type Return into the pty. That is a race against an
 * unknown amount of terminal drawing, and it answers whatever dialog happens
 * to be focused rather than the one we mean. Asserting trust in the config
 * before spawn is deterministic and inspectable.
 *
 * This writes to the operator's own `~/.claude.json`, so it merges key by key
 * and never rewrites the file wholesale: that file also holds their MCP
 * servers, their onboarding state and their per-project history.
 */
export const TRUST_KEY = 'hasTrustDialogAccepted';

export function claudeConfigPath(home = homedir()): string {
  return join(home, '.claude.json');
}

/** Marks each path trusted, returning the ones that were not already. */
export async function trustWorkspaces(
  paths: string[],
  configPath = claudeConfigPath(),
): Promise<string[]> {
  if (paths.length === 0) return [];

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // No config yet, or unreadable. A fresh object is the right starting point:
    // refusing to launch because the operator has never run Claude Code here
    // would be worse than writing the one key we need.
  }

  const projects = { ...((config.projects as Record<string, Record<string, unknown>>) ?? {}) };
  const added: string[] = [];

  for (const path of paths) {
    const key = resolve(path);
    const existing = projects[key];
    if (existing?.[TRUST_KEY] === true) continue;
    projects[key] = { ...(existing ?? {}), [TRUST_KEY]: true };
    added.push(key);
  }

  if (added.length === 0) return [];

  await writeFile(configPath, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, 'utf8');
  return added;
}

/** Whether a launch would stop on the trust dialog. Used to fail loudly, early. */
export async function untrusted(
  paths: string[],
  configPath = claudeConfigPath(),
): Promise<string[]> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return paths.map((path) => resolve(path));
  }
  const projects = (config.projects as Record<string, Record<string, unknown>>) ?? {};
  return paths.map((path) => resolve(path)).filter((key) => projects[key]?.[TRUST_KEY] !== true);
}
