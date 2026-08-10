import type { GitHubTransport, PullRequestRef } from '../../src/mirror/github.js';
import type { MirrorComment } from '../../src/mirror/render.js';

interface FakePull {
  number: number;
  branch: string;
  title: string;
  body: string;
  isDraft: boolean;
  comments: MirrorComment[];
}

/**
 * An in-memory GitHub, faked at the transport boundary the mirror owns rather
 * than at `execFile`. A mocked `execFile` would return whatever the test said
 * regardless of the subcommand, so `gh pr raedy` would pass — this fake cannot
 * be asked for an operation that does not exist, because it implements the same
 * interface the real transport does and the compiler checks both.
 *
 * It records calls as well as state, because the two prove different things:
 * state proves the mirror reached the right end result, calls prove it got
 * there by editing one comment rather than deleting and reposting it.
 */
export class FakeGitHub implements GitHubTransport {
  readonly calls: string[] = [];
  readonly pulls: FakePull[] = [];

  /** Set to make every call reject, standing in for an unreachable remote. */
  offline = false;

  #nextPull = 100;
  #nextComment = 1000;

  #check(call: string): void {
    this.calls.push(call);
    if (this.offline) throw new Error('getaddrinfo ENOTFOUND github.com');
  }

  #pull(number: number): FakePull {
    const pull = this.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) throw new Error(`no such pull request: ${number}`);
    return pull;
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequestRef | undefined> {
    this.#check(`find ${branch}`);
    const pull = this.pulls.find((candidate) => candidate.branch === branch);
    return pull === undefined ? undefined : { number: pull.number, isDraft: pull.isDraft, body: pull.body };
  }

  async createDraftPullRequest(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    this.#check(`create-draft ${input.branch}`);
    const pull: FakePull = {
      number: this.#nextPull++,
      branch: input.branch,
      title: input.title,
      body: input.body,
      isDraft: true,
      comments: [],
    };
    this.pulls.push(pull);
    return { number: pull.number, isDraft: true };
  }

  async markReady(number: number): Promise<void> {
    this.#check(`ready ${number}`);
    this.#pull(number).isDraft = false;
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    this.#check(`body ${number}`);
    this.#pull(number).body = body;
  }

  async listComments(number: number): Promise<MirrorComment[]> {
    this.#check(`list ${number}`);
    return this.#pull(number).comments.map((comment) => ({ ...comment }));
  }

  async createComment(number: number, body: string): Promise<MirrorComment> {
    this.#check(`comment ${number}`);
    const comment = { id: this.#nextComment++, body };
    this.#pull(number).comments.push(comment);
    return { ...comment };
  }

  async updateComment(id: number, body: string): Promise<void> {
    this.#check(`edit ${id}`);
    for (const pull of this.pulls) {
      const comment = pull.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) {
        comment.body = body;
        return;
      }
    }
    throw new Error(`no such comment: ${id}`);
  }

  /** Every comment on every PR, for count assertions. */
  allComments(): MirrorComment[] {
    return this.pulls.flatMap((pull) => pull.comments);
  }

  countCalls(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}
