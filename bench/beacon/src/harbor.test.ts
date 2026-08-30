import { describe, expect, it } from 'vitest';
import { createHarbor } from './harbor.js';

class FakeCanvas {
  width = 0;
  height = 0;
}

class FakeElement {
  children: unknown[] = [];
  appendChild(child: unknown): unknown {
    this.children.push(child);
    return child;
  }
}

describe('createHarbor', () => {
  it('does not throw on an empty mount and returns a canvas', () => {
    const root = new FakeElement() as unknown as HTMLElement;
    const previous = globalThis.document;
    (globalThis as { document?: { createElement: (tag: string) => unknown } }).document = {
      createElement: () => new FakeCanvas(),
    };
    try {
      const handle = createHarbor(root);
      expect(handle.canvas).toBeDefined();
      expect(handle.docked).toBe(0);
      expect(handle.lost).toBe(0);
    } finally {
      if (previous === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        globalThis.document = previous;
      }
    }
  });
});
