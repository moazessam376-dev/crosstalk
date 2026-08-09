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

  it('has no raw hex colours outside theme.css', async () => {
    const files = await glob('src/ui/**/*.{tsx,css}', { ignore: ['src/ui/theme.css'] });
    for (const file of files) {
      expect(await readFile(file, 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
