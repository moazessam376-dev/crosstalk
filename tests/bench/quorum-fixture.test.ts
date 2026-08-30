import { describe, expect, it } from 'vitest';
import { DecisionLog, IllegalTransitionError } from '../../bench/quorum/packages/api/src/log.js';
import { App } from '../../bench/quorum/packages/web/src/App.js';
import { render } from '../../bench/quorum/packages/web/src/render.js';

describe('quorum fixture as shipped', () => {
  it('type-level: seed exists and illegal transitions are named', () => {
    const log = new DecisionLog();
    expect(log.list()).toHaveLength(5);
    const resolved = log.list().find((row) => row.state === 'resolved');
    expect(resolved).toBeDefined();
    expect(() => log.move(resolved!.id, 'open')).toThrow(IllegalTransitionError);
  });

  it('keeps the vacuous render path — App does not show the seed', () => {
    expect(() => render()).not.toThrow();
    expect(App()).not.toContain('D-1');
    expect(App()).not.toContain('Ship the daemon');
  });
});
