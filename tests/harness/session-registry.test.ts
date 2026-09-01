import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../../src/harness/sessions.js';
import type { HarnessSession } from '../../src/harness/session.js';

/**
 * One process per seat, and a way to stop it.
 *
 * `register` was a bare `Map.set`. Seating an id a second time dropped the only
 * reference to the first process, and `SessionHandle` exposed no `stop`, so
 * that process could not be killed even on purpose — it kept its pty, kept its
 * worktree, and kept answering `/await`, so two `driveSupervised` loops raced
 * one `#delivered` cursor and each took about half of what the other was owed.
 *
 * The half that is easy to get wrong in the other direction: an *exited* seat
 * must still be re-seatable, because keeping a dead seat's screen is a
 * deliberate choice ("the single most useful screen in the run") and a new run
 * seats the same ids again.
 */

function fakeSession(id: string): HarnessSession & { stopped: number; die(code: number): void } {
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const session = {
    id,
    stopped: 0,
    exited,
    stop: () => {
      session.stopped += 1;
    },
    die: (code: number) => settle(code),
    screen: () => undefined,
    scrollback: () => undefined,
    resize: () => {},
    send: async () => {},
    key: async () => {},
    watch: () => () => {},
    canPush: true,
  };
  return session as unknown as HarnessSession & { stopped: number; die(code: number): void };
}

describe('the session registry', () => {
  it('refuses to seat an id whose process is still running', () => {
    const registry = new SessionRegistry();
    const first = fakeSession('peer-1');
    registry.register('peer-1', first);

    expect(() => registry.register('peer-1', fakeSession('peer-1'))).toThrow(/already running/);
    // And the original handle is still the one in the registry — a refusal that
    // half-replaced the entry would be worse than the silent overwrite.
    expect(registry.get('peer-1')!.running).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('lets an exited seat be seated again', async () => {
    const registry = new SessionRegistry();
    const first = fakeSession('peer-1');
    registry.register('peer-1', first);
    first.die(0);
    await first.exited;
    // The handle's `running` flag is set in a `.then`, so let it land.
    await Promise.resolve();

    const second = fakeSession('peer-1');
    expect(() => registry.register('peer-1', second)).not.toThrow();
    expect(registry.get('peer-1')!.running).toBe(true);
  });

  it('lists the seats that still have a process behind them', async () => {
    const registry = new SessionRegistry();
    const alive = fakeSession('peer-1');
    const dying = fakeSession('peer-2');
    registry.register('peer-1', alive);
    registry.register('peer-2', dying);
    expect(registry.live().map((session) => session.id)).toEqual(['peer-1', 'peer-2']);

    dying.die(1);
    await dying.exited;
    await Promise.resolve();

    expect(registry.live().map((session) => session.id)).toEqual(['peer-1']);
    // Dead, but still readable: the mirror shows the screen it died on.
    expect(registry.get('peer-2')).toBeDefined();
  });

  it('passes stop through to the process and nothing else', () => {
    const registry = new SessionRegistry();
    const session = fakeSession('peer-1');
    const handle = registry.register('peer-1', session);

    handle.stop();

    expect(session.stopped).toBe(1);
  });
});
