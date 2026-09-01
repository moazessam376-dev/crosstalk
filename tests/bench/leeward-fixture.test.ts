import { describe, expect, it } from 'vitest';
import { IllegalCatchError, School } from '../../bench/leeward/src/school.js';
import { TRADE, push } from '../../bench/leeward/src/wind.js';

describe('leeward fixture as shipped', () => {
  it('type-level: ten fish exist and illegal catches are named', () => {
    const school = new School();
    expect(school.list()).toHaveLength(10);
    school.catch('F-1');
    expect(() => school.catch('F-1')).toThrow(IllegalCatchError);
  });

  it('has a wind vector that can push a hull', () => {
    const delta = push(TRADE, 0, 1);
    expect(delta.x !== 0 || delta.z !== 0).toBe(true);
  });
});
