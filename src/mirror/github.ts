import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import type { MirrorComment } from './render.js';

const run = promisify(execFile);

export interface PullRequestRef {
  number: number;
  isDraft: boolean;
  /** Present on reads. Lets the reconciler skip a body update that changes nothing. */
  body?: string;
}

/**
 * Everything the mirror needs from GitHub, and nothing else.
 *
 * This interface is the boundary the tests fake. It is deliberately expressed
 * in the mirror's terms rather than in `gh`'s or the REST API's, so a test
 * double cannot drift from the real transport without the compiler noticing —
 * a mocked `execFile` would happily accept a misspelled subcommand.
 */
export interface GitHubTransport {
  findPullRequestByBranch(branch: string): Promise<PullRequestRef | undefined>;
  createDraftPullRequest(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
  markReady(number: number): Promise<void>;
  updatePullRequestBody(number: number, body: string): Promise<void>;
  listComments(number: number): Promise<MirrorComment[]>;
  createComment(number: number, body: string): Promise<MirrorComment>;
  updateComment(id: number, body: string): Promise<void>;
}

/**
 * Argument vectors, kept separate from the running of them so they can be
 * asserted without a process. `{owner}` and `{repo}` are `gh api`'s own
 * placeholders, resolved from the working directory — which is why every call
 * passes `cwd`.
 */
export const ghArgs = {
  findPullRequestByBranch: (branch: string): string[] => [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,isDraft,body',
    '--limit',
    '1',
  ],

  createDraftPullRequest: (input: {
    branch: string;
    title: string;
    body: string;
    base: string;
  }): string[] => [
    'pr',
    'create',
    '--draft',
    '--base',
    input.base,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body',
    input.body,
  ],

  markReady: (number: number): string[] => ['pr', 'ready', String(number)],

  updatePullRequestBody: (number: number, body: string): string[] => [
    'pr',
    'edit',
    String(number),
    '--body',
    body,
  ],

  listComments: (number: number): string[] => [
    'api',
    '--paginate',
    `repos/{owner}/{repo}/issues/${number}/comments`,
  ],

  createComment: (number: number, body: string): string[] => [
    'api',
    '--method',
    'POST',
    `repos/{owner}/{repo}/issues/${number}/comments`,
    '-f',
    `body=${body}`,
  ],

  // PATCH, never POST. The whole point of D1 is one comment per claim, and a
  // POST to the collection appends a second one on every edit.
  updateComment: (id: number, body: string): string[] => [
    'api',
    '--method',
    'PATCH',
    `repos/{owner}/{repo}/issues/comments/${id}`,
    '-f',
    `body=${body}`,
  ],
};

/**
 * Resolves `gh` on PATH.
 *
 * Reimplemented rather than shared with the private helper in
 * `src/harness/doctor.ts`, because that file belongs to another track. Worth
 * folding into one exported helper once the tracks merge — noted as a follow-up
 * rather than taken as a cross-track edit.
 */
export async function findGh(): Promise<string | undefined> {
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')]
      : [''];

  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || '.', `gh${extension}`);
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * `.cmd` and `.bat` cannot be launched by `execFile` on Windows without a
 * shell — `docs/CROSS-PLATFORM.md`. The argv array still goes through as an
 * array; what is never built is a command string.
 */
export function isWindowsShim(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

interface GhComment {
  id: number;
  body: string;
  author_association: string;
  user?: { login?: string };
}

/**
 * The `gh`-backed transport.
 *
 * `execFile`, never `exec`: the bodies it passes are agent-authored markdown
 * full of backticks, quotes and newlines, and a shell would turn some of that
 * into syntax. Every call is one argv array with the body as a single argument.
 */
export class GhTransport implements GitHubTransport {
  readonly #gh: string;
  readonly #cwd: string;
  readonly #base: string;

  private constructor(gh: string, cwd: string, base: string) {
    this.#gh = gh;
    this.#cwd = cwd;
    this.#base = base;
  }

  /** Undefined when `gh` is not installed — the mirror then degrades to nothing. */
  static async create(cwd: string, base: string): Promise<GhTransport | undefined> {
    const gh = await findGh();
    return gh === undefined ? undefined : new GhTransport(gh, cwd, base);
  }

  async #run(args: string[]): Promise<string> {
    const { stdout } = await run(this.#gh, args, {
      cwd: this.#cwd,
      shell: isWindowsShim(this.#gh),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequestRef | undefined> {
    const stdout = await this.#run(ghArgs.findPullRequestByBranch(branch));
    const found = JSON.parse(stdout) as PullRequestRef[];
    return found[0];
  }

  /**
   * Put the branch on the remote, so there is something to open a PR against.
   *
   * Nothing in `src/` ran `git push`, and a seat branch exists only in the
   * seat's own worktree — so `gh pr create --head ct/opus` was being asked to
   * open a pull request for a branch GitHub had never seen. The mirror's PR
   * machinery has therefore never usefully run; last session the seats pushed
   * by hand and nobody noticed the gap.
   *
   * `--force-with-lease` rather than `--force`: a seat re-pushing its own
   * branch after a rebase is ordinary, and overwriting someone else's work
   * because the ref moved underneath is not.
   */
  async #pushBranch(branch: string): Promise<void> {
    await run('git', ['push', '--force-with-lease', '--set-upstream', 'origin', branch], {
      cwd: this.#cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
  }

  async createDraftPullRequest(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    await this.#pushBranch(input.branch);
    await this.#run(ghArgs.createDraftPullRequest({ ...input, base: this.#base }));

    // `gh pr create` prints the URL, not JSON. Reading the PR back by branch
    // is also the restart path, so it is one code path rather than two.
    const created = await this.findPullRequestByBranch(input.branch);
    if (created === undefined) {
      throw new Error(`gh pr create succeeded but no pull request exists for ${input.branch}`);
    }
    return created;
  }

  async markReady(number: number): Promise<void> {
    await this.#run(ghArgs.markReady(number));
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    await this.#run(ghArgs.updatePullRequestBody(number, body));
  }

  async listComments(number: number): Promise<MirrorComment[]> {
    const stdout = await this.#run(ghArgs.listComments(number));
    const raw = JSON.parse(stdout) as GhComment[];
    return raw.map((comment) => ({
      id: comment.id,
      body: comment.body,
      authorAssociation: comment.author_association,
      ...(comment.user?.login === undefined ? {} : { authorLogin: comment.user.login }),
    }));
  }

  async createComment(number: number, body: string): Promise<MirrorComment> {
    const stdout = await this.#run(ghArgs.createComment(number, body));
    const created = JSON.parse(stdout) as GhComment;
    return {
      id: created.id,
      body: created.body,
      authorAssociation: created.author_association,
      ...(created.user?.login === undefined ? {} : { authorLogin: created.user.login }),
    };
  }

  async updateComment(id: number, body: string): Promise<void> {
    await this.#run(ghArgs.updateComment(id, body));
  }
}
