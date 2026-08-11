import { describe, expect, it } from 'vitest';

import { upBanner } from '../../src/cli/index.js';

/**
 * CT-11. The tokenised hub URL is the only way into the hub — the daemon
 * refuses a browser without it, and a refused hub renders as a quiet one
 * (CT-10). It was printed on exactly one branch: the `--no-open` one. Take the
 * default path and the line never appeared, so an operator who lost the
 * scrollback had no way back in, and the origin their browser autocompletes is
 * the untokenised one that gets refused.
 *
 * Reproduced by running `up` detached with stdout on a file: the full banner
 * printed, with no `Hub:` line anywhere in it.
 */
const PARTS = {
  url: 'http://127.0.0.1:7411',
  hubUrl: 'http://127.0.0.1:7411/?t=' + 'a'.repeat(64),
  cli: 'D:\\crosstalk\\dist\\cli\\index.js',
  hub: 'D:\\crosstalk\\dist\\ui',
  log: 'D:\\project\\.crosstalk\\events.jsonl',
  agents: ['leader', 'codex', '@human'],
};

const HUB_LINE = /Hub:\s+http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}/;

function bannerFor(browser: 'opening' | 'no-tty' | 'disabled'): string {
  return upBanner({ ...PARTS, browser }).join('\n');
}

describe('the up banner always says how to reach the hub', () => {
  it.each(['opening', 'no-tty', 'disabled'] as const)(
    'prints the tokenised url when the browser is %s',
    (browser) => {
      expect(bannerFor(browser)).toMatch(HUB_LINE);
    },
  );

  it('says so when it skipped the browser for want of a terminal', () => {
    // `rundll32` exits zero on a headless launch having opened nothing, so
    // "opened successfully" is not something `up` can honestly report there.
    expect(bannerFor('no-tty')).toMatch(/no terminal/i);
    expect(bannerFor('opening')).not.toMatch(/no terminal/i);
  });

  it('still prints the daemon url when there is no human token to embed', () => {
    // Nothing to tokenise, but the address is still worth having; the previous
    // shape printed neither.
    const lines = upBanner({ ...PARTS, hubUrl: undefined, browser: 'disabled' }).join('\n');

    expect(lines).toContain(PARTS.url);
    expect(lines).not.toMatch(HUB_LINE);
  });

  it('names the build it is running, so version skew is visible', () => {
    // CT-1: `ct` on PATH can be a different checkout, and every symptom of that
    // looks like a protocol bug until you know the two are not the same code.
    expect(bannerFor('opening')).toContain(PARTS.cli);
  });
});
