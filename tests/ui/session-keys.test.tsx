// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { SessionPanel } from '../../src/ui/session/SessionPanel.js';
import type { SeatSession } from '../../src/ui/state/useLaunch.js';

/**
 * Answering a dialog the seat drew itself.
 *
 * Every seat in the first hub-launched run stopped on the same screen — Claude
 * Code's bypass-permissions confirmation, cursor on "No, exit" — and the mirror
 * could see it and not answer it. The composer was the only input, and a
 * composer sends a *turn*: text with Return appended, which a select dialog
 * ignores. So four terminals sat on a question with the answer visible on
 * screen and no key to press.
 *
 * These are those keys. They go out as raw bytes, exactly what a keyboard
 * sends, which is also why they are not gated on `canPush`: pushing a turn is a
 * property of the harness, pressing a key is a property of having a terminal.
 */

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

const SEAT: SeatSession = {
  id: 'peer-1',
  role: 'peer',
  harness: 'claude-code-live',
  model: 'claude-opus-5',
  effort: 'high',
  workspace: '.crosstalk/worktrees/peer-1',
  present: true,
  activity: null,
  remoteControl: null,
  mirrored: true,
};

const SCREEN = {
  version: 1,
  cols: 20,
  cursor: { row: 0, col: 0 },
  rows: [[{ text: 'Yes, I accept' }]],
};

function mockMirror(running: boolean, canPush: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (String(input).includes('/screen')) {
        return { ok: true, status: 200, json: async () => ({ seat: SEAT.id, running, canPush, screen: SCREEN }) };
      }
      return { ok: true, status: 200, json: async () => ({ seat: SEAT.id, sent: 'keys' }) };
    }),
  );
}

function keyPayloads(): string[] {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { body?: string }][] } }).mock.calls;
  return calls
    .filter(([url]) => url.includes('/input'))
    .map(([, init]) => JSON.parse(init?.body ?? '{}') as { keys?: string })
    .filter((body) => body.keys !== undefined)
    .map((body) => body.keys as string);
}

beforeEach(() => mockMirror(true, true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('driving a mirrored terminal by key', () => {
  it('sends the bytes a real arrow key sends', async () => {
    render(createElement(SessionPanel, { seat: SEAT, onClose: () => {} }));
    fireEvent.click(await screen.findByLabelText(`Press down in ${SEAT.id}`));

    await waitFor(() => expect(keyPayloads()).toContain(`${ESC}[B`));
  });

  /**
   * The whole point of the seam. `send` strips newlines and appends Return to a
   * prompt; this is Return and nothing else, which is what a confirmation wants.
   */
  it('sends a bare Return, not a turn', async () => {
    render(createElement(SessionPanel, { seat: SEAT, onClose: () => {} }));
    fireEvent.click(await screen.findByLabelText(`Press return in ${SEAT.id}`));

    await waitFor(() => expect(keyPayloads()).toContain(CR));
  });

  it('offers up, down, return and escape — what a select dialog needs', async () => {
    render(createElement(SessionPanel, { seat: SEAT, onClose: () => {} }));
    const row = (await screen.findByTestId('session-keys')) as unknown as {
      querySelectorAll(selector: string): { getAttribute(name: string): string | null }[];
    };
    const names = [...row.querySelectorAll('button')].map((button) => button.getAttribute('data-key'));
    expect(names).toEqual(['up', 'down', 'return', 'escape']);
  });

  /**
   * The distinction that makes this useful: a seat whose harness reads its
   * prompt once can never take another turn, and its composer is correctly
   * disabled — but it still has a terminal, and a dialog on that terminal still
   * has to be answerable.
   */
  it('stays usable on a seat that cannot take another turn', async () => {
    mockMirror(true, false);
    render(createElement(SessionPanel, { seat: SEAT, onClose: () => {} }));

    expect(await screen.findByTestId('session-keys')).toBeInTheDocument();
    expect(screen.getByTestId('session-input')).toBeDisabled();
  });

  /** Nothing on the other end of a dead pty. */
  it('goes away once the seat has exited', async () => {
    mockMirror(false, false);
    render(createElement(SessionPanel, { seat: SEAT, onClose: () => {} }));

    await waitFor(() => expect(screen.queryByTestId('session-keys')).not.toBeInTheDocument());
  });
});
