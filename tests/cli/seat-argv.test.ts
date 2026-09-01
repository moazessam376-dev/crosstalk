import { describe, expect, it } from 'vitest';

import { nameRemoteControl, withFreshSession, withPermissionMode, withSeatModel } from '../../src/cli/compose.js';

const LIVE = ['claude', '--remote-control', '--permission-mode', 'auto'];

describe('naming a Remote Control session', () => {
  it('names the session after the seat', () => {
    // Unnamed, Remote Control falls back to the hostname — so three seats on
    // one machine show up as three identically named sessions, which is
    // useless on a phone. The seat id is what the board already calls it.
    expect(nameRemoteControl(LIVE, 'opus')).toEqual([
      'claude',
      '--remote-control',
      'opus',
      '--permission-mode',
      'auto',
    ]);
  });

  it('leaves an already-named session alone', () => {
    const named = ['claude', '--remote-control', 'chosen', '--model', 'claude-opus-5'];
    expect(nameRemoteControl(named, 'opus')).toEqual(named);
  });

  it('handles the flag arriving last', () => {
    expect(nameRemoteControl(['claude', '--remote-control'], 'luna')).toEqual([
      'claude',
      '--remote-control',
      'luna',
    ]);
  });

  it('does nothing to a harness that has no such flag', () => {
    const codex = ['codex', 'exec', '--json'];
    expect(nameRemoteControl(codex, 'opus')).toEqual(codex);
  });
});

describe('per-seat model and effort', () => {
  it('carries the roster’s choice onto the command line', () => {
    // crosstalk.yaml has held model and effort per participant all along and
    // the spawn path never read them, so every seat silently ran the default.
    expect(withSeatModel(['claude'], { model: 'claude-opus-5', effort: 'high' })).toEqual([
      'claude',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
    ]);
  });

  it('does not override a harness that already pins them', () => {
    const pinned = ['claude', '--model', 'claude-haiku-4-5-20251001'];
    expect(withSeatModel(pinned, { model: 'claude-opus-5', effort: 'high' })).toEqual([
      'claude',
      '--model',
      'claude-haiku-4-5-20251001',
      '--effort',
      'high',
    ]);
  });

  it('omits what the roster does not say', () => {
    expect(withSeatModel(['claude'], {})).toEqual(['claude']);
  });
});

/**
 * A seat is a new agent each run, not a continuation of the last one — but its
 * workspace is the same directory every time, so anything a harness carries
 * forward per directory follows it in. The operator watched exactly that:
 * relaunching and landing back in the previous, broken run's conversation with
 * its composer still full of unsent turns.
 *
 * A UUID nobody has used is a conversation nobody has had.
 */
describe('a fresh conversation per launch', () => {
  it('pins the seat to a session id of its own', () => {
    const argv = withFreshSession(['claude', '--remote-control', 'peer-1'], 'a3cd593a-d17b-4e27-9a03-d55ac660d572');
    expect(argv).toEqual(['claude', '--remote-control', 'peer-1', '--session-id', 'a3cd593a-d17b-4e27-9a03-d55ac660d572']);
  });

  it('gives two launches of the same seat two different conversations', () => {
    const idOf = (argv: string[]): string | undefined => argv[argv.indexOf('--session-id') + 1];
    expect(idOf(withFreshSession(['claude']))).not.toBe(idOf(withFreshSession(['claude'])));
  });

  it('generates a real UUID, which is all the flag accepts', () => {
    const id = withFreshSession(['claude'])[2];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  /** Somebody else's flag. Another harness gets its argv untouched. */
  it('leaves a harness that is not claude alone', () => {
    expect(withFreshSession(['codex', 'exec', '--json'])).toEqual(['codex', 'exec', '--json']);
    expect(withFreshSession(['cursor-agent', '-p'])).toEqual(['cursor-agent', '-p']);
  });

  it('does not override a session id that was already chosen', () => {
    const argv = ['claude', '--session-id', 'kept'];
    expect(withFreshSession(argv)).toEqual(argv);
  });
});

describe('the permission mode a seat runs under', () => {
  it('defaults to one that can ask, because somebody is watching', () => {
    // `bypassPermissions` was right for an unattended seat. A mirrored seat is
    // watched by definition: the hub draws its terminal and takes its keyboard,
    // so a question it asks is a question the operator can answer.
    expect(LIVE).toContain('auto');
    expect(LIVE).not.toContain('bypassPermissions');
  });

  it('takes the operator\'s choice over the registry default', () => {
    expect(withPermissionMode(LIVE, 'bypassPermissions')).toEqual([
      'claude',
      '--remote-control',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('replaces rather than appends, so no harness sees the flag twice', () => {
    const once = withPermissionMode(LIVE, 'plan');
    expect(once.filter((argument) => argument === '--permission-mode')).toHaveLength(1);
  });

  it('adds the flag to a harness whose spawn line has none', () => {
    expect(withPermissionMode(['codex', 'exec'], 'auto')).toEqual([
      'codex',
      'exec',
      '--permission-mode',
      'auto',
    ]);
  });

  it('leaves argv alone when the roster said nothing', () => {
    expect(withPermissionMode(LIVE, undefined)).toEqual(LIVE);
  });
});
