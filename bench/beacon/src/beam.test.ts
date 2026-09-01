import { describe, expect, it } from 'vitest';
import { lit, restingBeam, sweep } from './beam.js';

describe('sweep', () => {
  it('advances the bearing and wraps at a full turn', () => {
    const beam = restingBeam();
    const later = sweep(beam, 1);
    expect(later.bearing).toBeGreaterThan(beam.bearing);
    const wrapped = sweep({ ...beam, bearing: Math.PI * 2 - 0.01 }, 1);
    expect(wrapped.bearing).toBeLessThan(Math.PI * 2);
  });
});

describe('lit', () => {
  it('lights a bearing inside the arc and not one behind the tower', () => {
    const beam = { bearing: 0, spread: Math.PI / 10 };
    expect(lit(beam, 0)).toBe(true);
    expect(lit(beam, Math.PI)).toBe(false);
  });
});
