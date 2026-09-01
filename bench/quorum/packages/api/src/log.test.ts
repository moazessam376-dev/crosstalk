import { describe, expect, it } from 'vitest';
import { DecisionLog, IllegalTransitionError } from './log.js';

describe('decision log', () => {
  it('seeds five decisions with both open and resolved rows', () => {
    const log = new DecisionLog();
    expect(log.list()).toHaveLength(5);
    expect(log.list().some((row) => row.state === 'resolved')).toBe(true);
    expect(log.list().some((row) => row.state === 'open')).toBe(true);
  });

  it('rejects an illegal transition with a named error', () => {
    const log = new DecisionLog();
    const resolved = log.list().find((row) => row.state === 'resolved');
    expect(resolved).toBeDefined();
    expect(() => log.move(resolved!.id, 'open')).toThrow(IllegalTransitionError);
    expect(() => log.move(resolved!.id, 'open')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });

  it('permits open -> resolved', () => {
    const log = new DecisionLog();
    const open = log.list().find((row) => row.state === 'open');
    expect(open).toBeDefined();
    expect(log.move(open!.id, 'resolved').state).toBe('resolved');
  });
});
