import { describe, expect, it } from 'vitest';

import { boardTurn, driveSupervised } from '../../src/harness/runner.js';
import type { Inbox } from '../../src/core/inbox.js';

/**
 * A seat is told a thing once.
 *
 * The wake loop pushed a turn whenever `next` was anything other than `idle`,
 * and with a shape configured `next` is the phase status — "plan:
 * contract-exists — no contract path is configured for this shape" — which
 * stays exactly that until somebody writes the contract. So the loop polled,
 * got an instant answer with nothing unread, wrote a turn, polled again, got an
 * instant answer, wrote again: a hot spin, as fast as HTTP allows, in every
 * seat at once.
 *
 * The operator found it as dozens of identical board notices stacked in every
 * peer's composer. It is not cosmetic — that is a run's context and token
 * budget spent on one repeated sentence before any work starts.
 *
 * It was dormant until the team shape started reaching the config: before that
 * `phase` was undefined, `next` fell back to `idle`, and the loop blocked
 * correctly. Fixing one bug switched the other on.
 */

const STATUS = 'plan: contract-exists — no contract path is configured for this shape';

function inbox(over: Partial<Inbox> = {}): Inbox {
  return { who: 'peer-1', unread: [], mine: [], next: STATUS, ...over } as unknown as Inbox;
}

/** Answers `n` polls, then blocks forever so the loop settles. */
function pollsReturning(answers: Inbox[]): () => Promise<Inbox> {
  let at = 0;
  return () => {
    const answer = answers[at];
    at += 1;
    if (answer === undefined) return new Promise<Inbox>(() => {});
    return Promise.resolve(answer);
  };
}

async function run(answers: Inbox[]): Promise<{ turns: string[]; notices: string[] }> {
  const turns: string[] = [];
  const notices: string[] = [];
  const drive = driveSupervised({
    wait: pollsReturning(answers),
    write: async (turn) => {
      turns.push(turn);
    },
    exited: new Promise((resolve) => setTimeout(() => resolve(0), 250)),
    notify: async (body) => {
      notices.push(body);
    },
    formatTurn: boardTurn,
  });
  await drive;
  return { turns, notices };
}

describe('waking a seat', () => {
  it('does not repeat a standing status it has already sent', async () => {
    // Five polls, same unmet gate, nothing unread — which is exactly what the
    // server used to answer instantly, over and over.
    const { turns } = await run([inbox(), inbox(), inbox(), inbox(), inbox()]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain('contract-exists');
  });

  it('sends again when the status actually changes', async () => {
    const { turns } = await run([
      inbox(),
      inbox({ next: 'build: tests-green — nobody has posted it' }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain('tests-green');
  });

  /**
   * The half of this that cost the most. A card handed back as unread over and
   * over produces the same turn every time, and the seat gets the same message
   * typed into its composer again and again — which is what the operator was
   * watching happen to a terminal they had focused.
   */
  it('does not re-deliver a card it has already handed over', async () => {
    const card = { seq: 7, from: 'peer-2', room: '#floor', kind: 'said', body: 'I will take the sim' };
    const { turns } = await run([
      inbox({ unread: [card] as unknown as Inbox['unread'] }),
      inbox({ unread: [card] as unknown as Inbox['unread'] }),
      inbox({ unread: [card] as unknown as Inbox['unread'] }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain('I will take the sim');
  });

  /** But a different card is news, and has to arrive. */
  it('delivers the next thing a teammate says', async () => {
    const first = { seq: 7, from: 'peer-2', room: '#floor', kind: 'said', body: 'I will take the sim' };
    const second = { seq: 8, from: 'peer-3', room: '#floor', kind: 'said', body: 'I will take the renderer' };
    const { turns } = await run([
      inbox({ unread: [first] as unknown as Inbox['unread'] }),
      inbox({ unread: [second] as unknown as Inbox['unread'] }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain('renderer');
  });

  it('still says nothing at all when the seat is idle', async () => {
    const { turns } = await run([inbox({ next: 'idle' }), inbox({ next: 'idle' })]);
    expect(turns).toEqual([]);
  });
});
