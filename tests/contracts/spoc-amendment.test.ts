import { describe, expect, it } from 'vitest';
import type { Participant } from '../../src/contracts/participant.js';
import type { PolicyConfig } from '../../src/contracts/config.js';

/**
 * Named thaw for the team OS rebuild: SPOC is a seat, and acceptance may
 * name that participant. Existing configs without `delegate` must still type.
 */
describe('SPOC contract amendment', () => {
  it('accepts role: spoc on a participant', () => {
    const spoc: Participant = {
      id: 'spoc',
      role: 'spoc',
      harness: 'claude-code-cli',
      lifecycle: 'attached',
      workspace: '.',
    };
    expect(spoc.role).toBe('spoc');
  });

  it('lets taskAcceptance name method spoc and a delegate', () => {
    const policy: PolicyConfig = {
      selfCritique: { required: true, minRounds: 1 },
      leaderCritique: { maxRounds: 2 },
      dispute: { maxRounds: 3, ladder: ['leader'], rungTimeouts: {} },
      taskAcceptance: { method: 'spoc', delegate: 'spoc' },
    };
    expect(policy.taskAcceptance.method).toBe('spoc');
    expect(policy.taskAcceptance.delegate).toBe('spoc');
  });

  it('leaves delegate optional so existing leader configs still type', () => {
    const policy: PolicyConfig = {
      selfCritique: { required: true, minRounds: 1 },
      leaderCritique: { maxRounds: 2 },
      dispute: { maxRounds: 3, ladder: ['leader'], rungTimeouts: {} },
      taskAcceptance: { method: 'leader' },
    };
    expect(policy.taskAcceptance.delegate).toBeUndefined();
  });
});
