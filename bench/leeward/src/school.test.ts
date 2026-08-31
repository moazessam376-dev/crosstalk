import { describe, expect, it } from 'vitest';
import { IllegalCatchError, School } from './school.js';

describe('school', () => {
  it('seeds ten swimming fish', () => {
    const school = new School();
    expect(school.list()).toHaveLength(10);
    expect(school.list().every((row) => row.state === 'swimming')).toBe(true);
    expect(school.landed()).toBe(0);
  });

  it('rejects catching a fish that is already landed', () => {
    const school = new School();
    school.catch('F-1');
    expect(() => school.catch('F-1')).toThrow(IllegalCatchError);
    expect(() => school.catch('F-1')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_CATCH' }),
    );
  });

  it('permits swimming -> landed and ends at ten', () => {
    const school = new School();
    for (const row of school.list()) {
      expect(school.catch(row.id).state).toBe('landed');
    }
    expect(school.landed()).toBe(10);
  });
});
