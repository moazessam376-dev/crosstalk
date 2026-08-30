import { describe, expect, it } from 'vitest';
import { startCinder } from './boot.js';

/**
 * Do not change this test. It runs in `environment: 'node'` against a fake
 * document whose canvas has no `getContext`, which is why `startCinder` has to
 * stay lazy about WebGL.
 *
 * It passing proves the module loads. It proves nothing about the page.
 */
class FakeCanvas {
  width = 0;
  height = 0;
  style: Record<string, string> = {};
}

describe('startCinder', () => {
  it('appends a canvas and reports an empty tally', () => {
    const children: unknown[] = [];
    const root = { appendChild: (child: unknown) => children.push(child) } as unknown as HTMLElement;
    (globalThis as { document?: unknown }).document = {
      createElement: () => new FakeCanvas(),
    };

    const cinder = startCinder(root);

    expect(children).toHaveLength(1);
    expect(cinder.evacuated).toBe(0);
    expect(cinder.lost).toBe(0);
  });
});
