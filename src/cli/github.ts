import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';

import type { CrosstalkConfig, MirrorMode } from '../contracts/config.js';
import { CONFIG_FILENAME } from '../daemon/config.js';
import { CliError, EXIT } from './client.js';

const execFile = promisify(execFileCallback);

/** Where the mirror polls from, when nobody says otherwise. */
const DEFAULT_POLL_SECONDS = 30;

export interface GithubRepo {
  owner: string;
  repo: string;
  /** The form git wants, whatever form arrived. */
  url: string;
}

/**
 * Read `owner/repo` out of whatever is on the clipboard.
 *
 * Three forms, because those are the three things a browser, `gh` and the
 * GitHub clone button actually hand you. Anything else throws rather than
 * guessing: a mirror pointed at the wrong repository is worse than one that
 * refused to be configured, and this is the value every PR is opened against.
 */
export function parseRepoUrl(input: string): GithubRepo {
  const trimmed = input.trim().replace(/\/+$/, '');
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^([A-Za-z0-9][A-Za-z0-9-_.]*)\/([A-Za-z0-9][A-Za-z0-9-_.]*?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const found = pattern.exec(trimmed);
    if (found === null) continue;
    const [, owner, repo] = found;
    if (owner === undefined || repo === undefined || owner === '' || repo === '') continue;
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  }

  throw new CliError(
    `could not read a GitHub repository out of "${input}"`,
    EXIT.usage,
    'Paste the browser URL (https://github.com/owner/repo), the SSH remote, or just owner/repo.',
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/**
 * Point the repository at a GitHub remote and turn the mirror on.
 *
 * Read-modify-write rather than a rebuild: `runInit` regenerates the whole file
 * and this must not, because the operator's roster and shape are in it and this
 * command is about one block.
 */
export async function configureGithub(options: {
  repo: string;
  url: string;
  login?: string;
  mode?: MirrorMode;
  remote?: string;
}): Promise<{ repo: GithubRepo; remote: string; humanLogin: string; configPath: string }> {
  const root = resolve(options.repo);
  const target = parseRepoUrl(options.url);
  const remote = options.remote ?? 'origin';
  const configPath = join(root, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new CliError(
      `no ${CONFIG_FILENAME} in ${root}`,
      EXIT.protocol,
      'Run `crosstalk init` first — the mirror is a block inside the config, not a file of its own.',
    );
  }

  const config = parse(raw) as CrosstalkConfig;

  // Whose comments count as the operator's. Without it `two-way-human` degrades
  // to one-way in silence on any org repo: `author_association === 'OWNER'`
  // matched none of 300 comments across three org repos, and all 98 on the
  // user-owned one. The owner segment is right for a personal repo and wrong
  // for an org, so it is a default and not a rule.
  const humanLogin = options.login ?? target.owner;

  config.mirror = {
    github: {
      enabled: true,
      mode: options.mode ?? 'two-way-human',
      pollSeconds: config.mirror?.github.pollSeconds ?? DEFAULT_POLL_SECONDS,
      humanLogin,
    },
  };

  // `gh` resolves {owner}/{repo} from the remote of the working directory, so
  // the remote is not a convenience here — it is how the mirror knows which
  // repository it is mirroring to.
  const existing = await git(root, ['remote']).catch(() => '');
  const has = existing.split(/\r?\n/).some((line) => line.trim() === remote);
  await git(root, has ? ['remote', 'set-url', remote, target.url] : ['remote', 'add', remote, target.url]);

  await writeFile(configPath, stringify(config), 'utf8');
  return { repo: target, remote, humanLogin, configPath };
}
