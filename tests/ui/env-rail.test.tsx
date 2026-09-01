// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { EnvironmentRail } from '../../src/ui/env/EnvironmentRail.js';
import type { SessionsView } from '../../src/ui/state/useLaunch.js';

afterEach(cleanup);

function sessions(seat: Partial<SessionsView['seats'][number]> = {}): SessionsView {
  return {
    seats: [
      {
        id: 'opus',
        role: 'peer',
        harness: 'claude-code-live',
        present: true,
        activity: null,
        mirrored: true,
        remoteControl: 'opus',
        ...seat,
      } as SessionsView['seats'][number],
    ],
  } as SessionsView;
}

describe('seat health on the rail', () => {
  it('draws a seat the supervisor could not reach as stalled', () => {
    // The roster has carried this since presence existed and nothing drew it.
    // The same notices used to be posted to `#floor` under the operator's name
    // — 622 of one run's 1187 events — and moving them to presence was only
    // half the repair: a fact nobody renders is a fact nobody has.
    render(
      createElement(EnvironmentRail, {
        sessions: sessions({
          activity: { verb: 'starting', working: false, blocked: 'is waiting on something on its own screen', at: 1 },
        }),
      }),
    );
    const seat = screen.getByTestId('env-seat-opus');
    expect(seat).toHaveAttribute('data-blocked', 'true');
    expect(seat).toHaveAttribute('title', expect.stringContaining('waiting on something'));
  });

  it('leaves a healthy seat alone', () => {
    render(createElement(EnvironmentRail, { sessions: sessions() }));
    expect(screen.getByTestId('env-seat-opus')).not.toHaveAttribute('data-blocked');
  });
});

describe('pointing the mirror at a repository from the hub', () => {
  it('offers a field when nothing is configured', () => {
    render(
      createElement(EnvironmentRail, {
        mirror: { configured: false, enabled: false },
        onConfigureMirror: async () => ({ ok: true }),
      }),
    );
    expect(screen.getByTestId('env-mirror-url')).toBeInTheDocument();
  });

  it('sends what was pasted', async () => {
    const onConfigureMirror = vi.fn(async () => ({ ok: true }));
    render(
      createElement(EnvironmentRail, {
        mirror: { configured: false, enabled: false },
        onConfigureMirror,
      }),
    );

    fireEvent.change(screen.getByTestId('env-mirror-url'), {
      target: { value: 'https://github.com/owner/repo' },
    });
    fireEvent.click(screen.getByTestId('env-mirror-save'));

    await waitFor(() => expect(onConfigureMirror).toHaveBeenCalledWith('https://github.com/owner/repo'));
  });

  it('says why it was refused rather than clearing the box', async () => {
    render(
      createElement(EnvironmentRail, {
        mirror: { configured: false, enabled: false },
        onConfigureMirror: async () => ({ ok: false, reason: 'could not read a GitHub repository out of that' }),
      }),
    );

    fireEvent.change(screen.getByTestId('env-mirror-url'), { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByTestId('env-mirror-save'));

    await waitFor(() =>
      expect(screen.getByTestId('env-mirror-notice')).toHaveTextContent('could not read a GitHub repository'),
    );
    expect(screen.getByTestId('env-mirror-url')).toHaveValue('nonsense');
  });

  it('does not offer to re-point a mirror that is already set up', () => {
    // A repo box beside a working mirror is a way to send a run's PRs somewhere
    // else by accident.
    render(
      createElement(EnvironmentRail, {
        mirror: { configured: true, enabled: true },
        onConfigureMirror: async () => ({ ok: true }),
      }),
    );
    expect(screen.queryByTestId('env-mirror-url')).toBeNull();
  });

  it('shows no field at all in a hub with no daemon behind it', () => {
    render(createElement(EnvironmentRail, { mirror: { configured: false, enabled: false } }));
    expect(screen.queryByTestId('env-mirror-url')).toBeNull();
  });
});
