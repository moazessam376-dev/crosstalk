// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { EnvironmentRail } from '../../src/ui/env/EnvironmentRail.js';

afterEach(cleanup);

/**
 * The mirror had no surface in the hub at all, and no way to get one: it has no
 * write path into the log, and the hub renders the log. Its status arrives on
 * its own route instead.
 *
 * Four states the operator acts on differently — never set up, set up but not
 * running, running, and not yet asked — and three of them looked identical
 * before this had a surface. That is CT-10's mistake in miniature: a refused
 * hub and a quiet one rendering the same.
 *
 * It reads the environment rail rather than the dock. The status moved there
 * with the rest of what frames a run; two surfaces reporting one fact is two
 * vocabularies the operator has to learn to rank.
 */
describe('the mirror status', () => {
  it('says the mirror is not configured, rather than showing nothing', () => {
    render(createElement(EnvironmentRail, { mirror: { configured: false, enabled: false } }));

    expect(screen.getByTestId('env-mirror')).toHaveTextContent(/no mirror configured/i);
    // The state is on the element too, so the three cases are distinguishable
    // without depending on the wording staying put.
    expect(screen.getByTestId('env-mirror-state')).toHaveAttribute('data-state', 'off');
  });

  it('distinguishes configured-but-not-running from running', () => {
    render(createElement(EnvironmentRail, { mirror: { configured: true, enabled: false } }));
    expect(screen.getByTestId('env-mirror')).toHaveTextContent(/not running/i);

    cleanup();
    render(createElement(EnvironmentRail, {
      mirror: { configured: true, enabled: true, lastDrain: { completed: 4, retrying: 0 } },
    }));
    expect(screen.getByTestId('env-mirror')).toHaveTextContent(/mirroring to GitHub/i);
    expect(screen.getByTestId('env-mirror-state')).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('env-mirror')).toHaveTextContent('4');
  });

  it('shows the retry count, because a mirror retrying forever looks like one that works', () => {
    render(createElement(EnvironmentRail, {
      mirror: { configured: true, enabled: true, lastDrain: { completed: 0, retrying: 7 } },
    }));

    expect(screen.getByTestId('env-mirror')).toHaveTextContent('7');
  });

  it('shows the error when starting it failed', () => {
    render(createElement(EnvironmentRail, {
      mirror: { configured: true, enabled: false, lastError: 'gh: not authenticated' },
    }));

    expect(screen.getByTestId('env-mirror')).toHaveTextContent('gh: not authenticated');
  });

  it('renders nothing at all when the daemon has not reported yet', () => {
    // `undefined` means "not asked yet", which is not the same as "off" — and a
    // rail that flashed "not configured" on every load before the first fetch
    // returned would be a lie the operator sees more often than the truth.
    render(createElement(EnvironmentRail, {}));

    expect(screen.queryByTestId('env-mirror')).not.toBeInTheDocument();
  });
});
