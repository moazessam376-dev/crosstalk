// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Dock } from '../../src/ui/layout/Dock.js';

afterEach(cleanup);

const base = {
  events: [],
  rooms: [{ id: '#floor', kind: 'floor' as const }],
  activeRoom: '#floor',
  participants: [],
};

/**
 * The mirror had no surface in the hub at all, and no way to get one: it has no
 * write path into the log, and the hub renders the log. Its status arrives on
 * its own route instead.
 *
 * Four states the operator acts on differently — never set up, set up but not
 * running, running, and not yet asked — and three of them looked identical
 * before this card existed. That is CT-10's mistake in miniature: a refused hub
 * and a quiet one rendering the same.
 */
describe('the mirror card', () => {
  it('says the mirror is not configured, rather than showing nothing', () => {
    render(createElement(Dock, { ...base, mirror: { configured: false, enabled: false } }));

    expect(screen.getByTestId('dock-mirror')).toHaveTextContent(/not configured/i);
  });

  it('distinguishes configured-but-not-running from running', () => {
    render(createElement(Dock, { ...base, mirror: { configured: true, enabled: false } }));
    expect(screen.getByTestId('dock-mirror')).toHaveTextContent(/not running/i);

    cleanup();
    render(createElement(Dock, {
      ...base,
      mirror: { configured: true, enabled: true, lastDrain: { completed: 4, retrying: 0 } },
    }));
    expect(screen.getByTestId('dock-mirror')).toHaveTextContent(/running/i);
    expect(screen.getByTestId('dock-mirror')).toHaveTextContent('4');
  });

  it('shows the retry count, because a mirror retrying forever looks like one that works', () => {
    render(createElement(Dock, {
      ...base,
      mirror: { configured: true, enabled: true, lastDrain: { completed: 0, retrying: 7 } },
    }));

    expect(screen.getByTestId('dock-mirror')).toHaveTextContent('7');
  });

  it('shows the error when starting it failed', () => {
    render(createElement(Dock, {
      ...base,
      mirror: { configured: true, enabled: false, lastError: 'gh: not authenticated' },
    }));

    expect(screen.getByTestId('dock-mirror')).toHaveTextContent('gh: not authenticated');
  });

  it('renders no card at all when the daemon has not reported yet', () => {
    // `undefined` means "not asked yet", which is not the same as "off" — and a
    // card that flashed "not configured" on every load before the first fetch
    // returned would be a lie the operator sees more often than the truth.
    render(createElement(Dock, base));

    expect(screen.queryByTestId('dock-mirror')).not.toBeInTheDocument();
  });
});
