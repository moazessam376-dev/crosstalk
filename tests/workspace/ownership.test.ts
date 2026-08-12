import { describe, expect, it } from 'vitest';

import { isWithinPrefix, normalisePrefix, outsideOwnership, prefixesOverlap } from '../../src/workspace/ownership.js';

/**
 * Declared path ownership: which paths a participant may write when every agent
 * shares the repository root.
 *
 * Prefixes rather than globs, because the repo allows two runtime dependencies
 * and neither matches globs — and a hand-rolled matcher that is subtly wrong
 * about `**` would silently mis-scope the gate that decides whether a submit is
 * refused. A prefix is a question about directories, and the whole correctness
 * argument rests on one character: the trailing separator.
 */
describe('normalisePrefix', () => {
  it('gives every prefix exactly one trailing slash', () => {
    expect(normalisePrefix('src/metrics')).toBe('src/metrics/');
    expect(normalisePrefix('src/metrics/')).toBe('src/metrics/');
    expect(normalisePrefix('src/metrics///')).toBe('src/metrics/');
  });

  it('accepts a Windows separator, because a config is written by hand', () => {
    // `crosstalk.yaml` is edited by people on this platform and `src\metrics\`
    // is what they will type. Comparing it raw against a git path would never
    // match anything, and the failure would look like "ownership is ignored".
    expect(normalisePrefix('src\\metrics')).toBe('src/metrics/');
  });
});

describe('isWithinPrefix', () => {
  it('accepts a file inside the prefix, at any depth', () => {
    expect(isWithinPrefix('src/metrics/collect.ts', 'src/metrics/')).toBe(true);
    expect(isWithinPrefix('src/metrics/deep/nested/file.ts', 'src/metrics/')).toBe(true);
  });

  it('rejects a file outside it', () => {
    expect(isWithinPrefix('src/skeleton/frame.ts', 'src/metrics/')).toBe(false);
  });

  /**
   * The case a prefix check gets wrong if it forgets the separator.
   * `"src/metrics-old/collect.ts".startsWith("src/metrics")` is true, and
   * treating it as owned would let one agent commit another's files.
   */
  it('does not treat src/metrics-old/ as inside src/metrics/', () => {
    expect(isWithinPrefix('src/metrics-old/collect.ts', 'src/metrics/')).toBe(false);
  });

  it('matches a git path with backslashes against a POSIX prefix', () => {
    expect(isWithinPrefix('src\\metrics\\collect.ts', 'src/metrics/')).toBe(true);
  });
});

describe('prefixesOverlap', () => {
  it('reports a parent containing a child, in both directions', () => {
    // Order must not decide the answer: whichever participant is listed first
    // in the roster, `src/` and `src/metrics/` can clobber each other.
    expect(prefixesOverlap('src/', 'src/metrics/')).toBe(true);
    expect(prefixesOverlap('src/metrics/', 'src/')).toBe(true);
  });

  it('reports a prefix against itself', () => {
    expect(prefixesOverlap('src/metrics/', 'src/metrics/')).toBe(true);
  });

  it('leaves siblings alone', () => {
    expect(prefixesOverlap('src/metrics/', 'src/skeleton/')).toBe(false);
  });

  it('does not confuse src/metrics-old/ with a child of src/metrics/', () => {
    expect(prefixesOverlap('src/metrics/', 'src/metrics-old/')).toBe(false);
  });
});

describe('outsideOwnership', () => {
  it('names every path no prefix covers, and only those', () => {
    const outside = outsideOwnership(
      ['src/metrics/collect.ts', 'src/skeleton/frame.ts', 'tests/metrics/collect.test.ts', 'README.md'],
      ['src/metrics/', 'tests/metrics/'],
    );

    expect(outside).toEqual(['src/skeleton/frame.ts', 'README.md']);
  });

  it('returns nothing when everything is owned', () => {
    expect(outsideOwnership(['src/metrics/collect.ts'], ['src/metrics/'])).toEqual([]);
  });

  it('treats an empty ownership list as owning nothing, not everything', () => {
    // The direction of this default is the whole safety property. A participant
    // that declares nothing must not be able to commit anything — `doctor`
    // rejects that configuration, and if it ever slips through, the gate has to
    // fail closed rather than wave the change past.
    expect(outsideOwnership(['src/metrics/collect.ts'], [])).toEqual(['src/metrics/collect.ts']);
  });
});
