import { readFile } from 'node:fs/promises';
import { glob } from 'tinyglobby';
import { describe, expect, it } from 'vitest';

const REQUIRED = ['--surface-base', '--surface-panel', '--surface-raised', '--border-hairline',
  '--text-primary', '--text-secondary', '--text-tertiary', '--accent',
  '--status-fresh', '--status-stale', '--status-contested', '--status-blocker', '--status-open',
  '--font-ui', '--font-mono', '--size-ui', '--size-mono', '--row-h', '--radius'];

describe('theme tokens', () => {
  it('defines every design token on both theme selectors', async () => {
    const css = await readFile('src/ui/theme.css', 'utf8');
    for (const selector of [':root', ':root[data-theme="light"]']) {
      const selectorStart = css.indexOf(selector);
      expect(selectorStart).toBeGreaterThanOrEqual(0);
      const blockStart = css.indexOf('{', selectorStart);
      const blockEnd = css.indexOf('}', blockStart);
      expect(blockStart).toBeGreaterThan(selectorStart);
      expect(blockEnd).toBeGreaterThan(blockStart);
      const declarations = css.slice(blockStart, blockEnd);

      for (const token of REQUIRED) {
        expect(declarations).toMatch(new RegExp(`${token}\\s*:`));
      }
    }
  });

  /**
   * CT-15, kept fixed.
   *
   * The operator's most-repeated friction of the day: to send a message they
   * had to scroll to the very bottom of the log, and with agents writing
   * long-form that distance grew with every event. The hub redesign fixed it and
   * nothing pinned it.
   *
   * The DOM assertion in `layout.test.tsx` is not enough on its own, because the
   * composer's position is a **CSS** fact: delete `flex: 1` from `.stream-scroll`
   * and the composer scrolls away with the log again — CT-15 verbatim — while
   * remaining a non-descendant of it. Both halves, or neither is a guard.
   */
  it('keeps the composer pinned by pinning the rules that pin it', async () => {
    const css = await readFile('src/ui/theme.css', 'utf8');

    const block = (selector: string): string => {
      const at = css.lastIndexOf(`${selector} {`);
      expect(at, `${selector} is declared`).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };

    // The stream is a column that does not scroll...
    expect(block('.hub-stream')).toMatch(/flex-direction:\s*column/);
    expect(block('.hub-stream')).toMatch(/overflow:\s*hidden/);
    // ...the log inside it is the only thing that does...
    expect(block('.stream-scroll')).toMatch(/flex:\s*1/);
    expect(block('.stream-scroll')).toMatch(/min-height:\s*0/);
    expect(block('.stream-scroll')).toMatch(/overflow-y:\s*auto/);
    // ...and the composer holds its height rather than being squeezed out.
    expect(block('.composer')).toMatch(/flex:\s*none/);
  });

  it('declares .hub-stream exactly once, so no rule can win by source order', () => {
    // There were two contradictory `.hub-stream` blocks — one `overflow: auto`,
    // one `overflow: hidden` — and the pin survived only because the second came
    // later in the file. Reordering or extracting the stylesheet would have
    // silently restored the bug, with every test still green.
    return readFile('src/ui/theme.css', 'utf8').then((css) => {
      expect(css.match(/^\.hub-stream \{/gm) ?? []).toHaveLength(1);
    });
  });

  it('has no raw hex colours outside theme.css', async () => {
    const files = await glob('src/ui/**/*.{tsx,css}', { ignore: ['src/ui/theme.css'] });
    for (const file of files) {
      expect(await readFile(file, 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
