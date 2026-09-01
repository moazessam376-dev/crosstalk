import { describe, expect, it } from 'vitest';
import { TRADE, push, veer } from './wind.js';

describe('wind', () => {
  it('pushes the hull along the trade heading', () => {
    const delta = push(TRADE, 0, 1);
    expect(delta.x).not.toBe(0);
    expect(delta.z).not.toBe(0);
  });

  it('veers heading without dropping knots', () => {
    const next = veer(TRADE, 90);
    expect(next.heading).toBe(90);
    expect(next.knots).toBe(TRADE.knots);
  });
});
