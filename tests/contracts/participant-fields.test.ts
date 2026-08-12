import { describe, expect, it } from 'vitest';
import type { Participant } from '../../src/contracts/participant.js';

/**
 * `src/contracts/` is frozen (AGENTS.md rule 8). These two fields were added
 * under claims CT-A and CT-B in `docs/plans/2026-08-12-one-folder.md`, both
 * upheld by the leader with the maintainer's approval.
 *
 * The test is a compile-time assertion with a runtime witness, which is how the
 * rest of the suite pins contract shape without a schema library: the literal
 * below does not compile if either field is missing or mistyped.
 */
describe('participant fields shared root needs', () => {
  it('carries an effort level and a set of owned paths', () => {
    const participant: Participant = {
      id: 'metrics',
      role: 'worker',
      harness: 'claude-code-app',
      model: 'opus-5',
      effort: 'max',
      lifecycle: 'attached',
      workspace: '.',
      owns: ['src/metrics/', 'tests/metrics/'],
    };

    expect(participant.effort).toBe('max');
    expect(participant.owns).toEqual(['src/metrics/', 'tests/metrics/']);
  });

  it('leaves both optional, because every existing config omits them', () => {
    // The compatibility half. Rigit's five participants declare neither, and a
    // required field here would refuse to load a config that works today.
    const minimal: Participant = {
      id: 'leader',
      role: 'leader',
      harness: 'claude-code-app',
      lifecycle: 'attached',
      workspace: '.',
    };

    expect(minimal.effort).toBeUndefined();
    expect(minimal.owns).toBeUndefined();
  });
});
