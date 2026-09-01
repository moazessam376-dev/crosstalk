import { describe, expect, it } from 'vitest';

import { INHERITED_SESSION_MARKERS, PTY_TERM, seatEnv } from '../../src/harness/pty.js';

/**
 * A seat is its own agent, not a sub-agent of whoever started the daemon.
 *
 * When the daemon is launched from inside a CLI harness — which is how every
 * run so far has started — that harness's session markers sit in `process.env`,
 * and a seat spawned with a plain `...process.env` inherits them. Claude Code
 * reads one and turns transcript saving off, on the reasonable belief that it
 * is a child whose transcript belongs to a parent.
 *
 * Measured on the first hub-launched team: all three seats showed "Transcript
 * saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" and ran a whole
 * phase with nothing on disk to review afterwards. For a project whose point is
 * being able to say what the team actually did, a run with no transcript is the
 * expensive kind of missing.
 */

describe('the environment a seat runs in', () => {
  it('drops the session markers that would make a seat a child of the operator', () => {
    const env = seatEnv({ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', PATH: '/usr/bin' });

    for (const marker of INHERITED_SESSION_MARKERS) {
      expect(env[marker]).toBeUndefined();
    }
  });

  /**
   * Only the markers. A seat needs the operator's PATH to find its own binary,
   * its credentials to authenticate, and its home to read its config — stripping
   * the environment wholesale would trade one silent failure for a louder one.
   */
  it('keeps everything else the seat needs', () => {
    const env = seatEnv({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/someone',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_CHILD_SESSION: '1',
    });

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.HOME).toBe('/Users/someone');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('names the terminal the mirror actually implements', () => {
    expect(seatEnv({ TERM: 'dumb' }).TERM).toBe(PTY_TERM);
  });

  it('does not mutate the environment it was handed', () => {
    const original = { CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/usr/bin' };
    seatEnv(original);
    expect(original.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });
});
