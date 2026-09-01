import { describe, expect, it } from 'vitest';
import { render } from './render.js';

describe('render', () => {
  it('does not throw on empty props', () => {
    expect(() => render()).not.toThrow();
    expect(render()).toContain('<ul>');
  });
});
