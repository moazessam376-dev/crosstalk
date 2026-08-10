import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../contracts/config.js';
import { DaemonError } from './errors.js';

export const CONFIG_FILENAME = 'crosstalk.yaml';

/**
 * Reads `crosstalk.yaml` from the repo root.
 *
 * Nothing else in the project produced a `CrosstalkConfig` from disk — `doctor`
 * consumes one and no code built one — so this is the single loader, and D4's
 * CLI shares it. Two loaders that disagree about defaults is a bug with a long
 * fuse.
 *
 * A missing or unparseable config is a startup failure, not a protocol error:
 * it is thrown by `startDaemon` and never reaches HTTP.
 */
export async function loadConfig(repo: string): Promise<CrosstalkConfig> {
  const path = join(repo, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new DaemonError(
      'MALFORMED_CONFIG',
      `No ${CONFIG_FILENAME} at ${path} — run \`crosstalk init\` in the repository root`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new DaemonError(
      'MALFORMED_CONFIG',
      `${path} is not valid YAML: ${(error as Error).message}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new DaemonError('MALFORMED_CONFIG', `${path} is empty`);
  }

  const candidate = parsed as Partial<CrosstalkConfig>;

  if (!Array.isArray(candidate.participants) || candidate.participants.length === 0) {
    throw new DaemonError(
      'MALFORMED_CONFIG',
      `${path} declares no participants — the daemon mints one token per participant and cannot identify anyone without them`,
    );
  }

  for (const participant of candidate.participants) {
    if (typeof participant?.id !== 'string' || participant.id === '') {
      throw new DaemonError('MALFORMED_CONFIG', `${path} has a participant with no id`);
    }
  }

  const ids = candidate.participants.map((participant) => participant.id.toLowerCase());
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    // Case-insensitive: ids become directory and token filenames, and Windows
    // and macOS filesystems fold case. See docs/CROSS-PLATFORM.md §4.
    throw new DaemonError(
      'MALFORMED_CONFIG',
      `${path} declares two participants resolving to the id "${duplicate}" — ids must differ by more than case`,
    );
  }

  return {
    version: 1,
    project: candidate.project ?? { repo: '.', mainBranch: 'main' },
    participants: candidate.participants,
    policy: candidate.policy ?? DEFAULT_POLICY,
    ...(candidate.mirror === undefined ? {} : { mirror: candidate.mirror }),
  };
}
