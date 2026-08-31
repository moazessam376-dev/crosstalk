import { describe, expect, it } from 'vitest';

import { nameRemoteControl, withFreshSession, withSeatModel } from '../../src/cli/compose.js';

const LIVE = ['claude', '--remote-control', '--permission-mode', 'bypassPermissions'];

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
      'bypassPermissions',
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
