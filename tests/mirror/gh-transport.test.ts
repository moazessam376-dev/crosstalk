import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ghArgs, findGh, isWindowsShim } from '../../src/mirror/github.js';

const run = promisify(execFile);

describe('the gh argument vectors', () => {
  it('looks a pull request up by head branch, not by a stored number', () => {
    expect(ghArgs.findPullRequestByBranch('ct/T-04-refund')).toEqual([
      'pr',
      'list',
      '--head',
      'ct/T-04-refund',
      '--state',
      'all',
      '--json',
      'number,isDraft',
      '--limit',
      '1',
    ]);
  });

  it('opens the pull request as a draft', () => {
    const args = ghArgs.createDraftPullRequest({
      branch: 'ct/T-04-refund',
      title: 'T-04',
      body: 'brief',
      base: 'main',
    });

    // The draft flag is the acceptance criterion, so it gets its own assertion
    // rather than riding along inside a deep-equal that a reorder would break.
    expect(args).toContain('--draft');
    expect(args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(args).toEqual(expect.arrayContaining(['--base', 'main', '--head', 'ct/T-04-refund']));
  });

  it('marks ready by number', () => {
    expect(ghArgs.markReady(12)).toEqual(['pr', 'ready', '12']);
  });

  it('edits a comment in place with PATCH rather than posting a new one', () => {
    const args = ghArgs.updateComment(999, 'edited');

    expect(args).toEqual(expect.arrayContaining(['--method', 'PATCH']));
    expect(args.some((arg) => arg.includes('issues/comments/999'))).toBe(true);
    // A POST here would append a second comment on every edit, which is the
    // failure D1 exists to avoid.
    expect(args).not.toContain('POST');
  });

  it('reads comments from the endpoint that carries author_association', () => {
    const args = ghArgs.listComments(12);

    expect(args[0]).toBe('api');
    expect(args.some((arg) => arg.includes('issues/12/comments'))).toBe(true);
  });

  it('passes the body as one argument, so a newline or a quote cannot become syntax', () => {
    const nasty = 'line one\nline "two" & `three`\n\n<!-- crosstalk:claim:C-1 -->';
    const args = ghArgs.createComment(12, nasty);

    expect(args).toContain(`body=${nasty}`);
  });
});

/**
 * The plan's warning is that a mocked `execFile` passes against a typo'd
 * subcommand. Argument-shape tests cannot catch that on their own — they assert
 * the same typo the code contains. So this asks the installed `gh`.
 *
 * `gh <sub> --help` prints a USAGE line naming the subcommand it resolved. A
 * typo resolves to the *parent* and prints `gh pr <command>`, so the USAGE line
 * discriminates exactly. Both directions are asserted below, because a check
 * that cannot fail is worse than no check.
 *
 * `--help` is local: no credential, and `GH_NO_UPDATE_NOTIFIER` keeps it from
 * reaching for the release feed. The obvious alternative — running the real
 * subcommand and looking for "unknown command" — was tried and rejected:
 * `gh pr list` returns live pull requests, and the acceptance criteria say
 * these tests must not need network.
 */
describe('the gh subcommands exist in the installed gh', () => {
  const subcommands: string[][] = [
    ghArgs.findPullRequestByBranch('x').slice(0, 2),
    ghArgs.createDraftPullRequest({ branch: 'x', title: 't', body: 'b', base: 'main' }).slice(0, 2),
    ghArgs.markReady(1).slice(0, 2),
    ghArgs.updatePullRequestBody(1, 'b').slice(0, 2),
    ghArgs.listComments(1).slice(0, 1),
  ];

  async function usageLine(args: string[]): Promise<string> {
    const gh = await findGh();
    if (gh === undefined) return '';

    const { stdout } = await run(gh, [...args, '--help'], {
      shell: isWindowsShim(gh),
      timeout: 30_000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });

    const lines = stdout.split('\n');
    const heading = lines.findIndex((line) => line.trim().toUpperCase().startsWith('USAGE'));
    return heading === -1 ? '' : (lines[heading + 1] ?? '').trim();
  }

  it('resolves a typo to the parent command rather than to a subcommand', async () => {
    if ((await findGh()) === undefined) return;

    // The control. If this ever starts reporting `gh pr raedy`, the check below
    // has stopped discriminating and every subcommand assertion is vacuous.
    expect(await usageLine(['pr', 'raedy'])).not.toContain('raedy');
  }, 40_000);

  it.each(subcommands)('gh %s %s resolves to itself', async (...args: string[]) => {
    if ((await findGh()) === undefined) return;

    expect(await usageLine(args)).toContain(`gh ${args.join(' ')}`);
  }, 40_000);
});
