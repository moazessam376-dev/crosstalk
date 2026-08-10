import type { MirrorComment } from './render.js';

export interface PullRequestRef {
  number: number;
  isDraft: boolean;
}

/**
 * Everything the mirror needs from GitHub, and nothing else.
 *
 * This interface is the boundary tests fake. It is deliberately expressed in
 * the mirror's terms rather than in `gh`'s or the REST API's, so that a test
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
