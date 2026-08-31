import { describe, expect, it } from 'vitest';

import { nameRemoteControl, withSeatModel } from '../../src/cli/compose.js';

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
