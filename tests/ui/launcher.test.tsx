// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Launcher, seatsFor, clashingIds } from '../../src/ui/launch/Launcher.js';
import type { ShapeSummary } from '../../src/ui/state/useLaunch.js';

afterEach(cleanup);

const TRIO: ShapeSummary = {
  name: 'trio-contract',
  summary: 'Three peers, one frozen contract, one of them integrates and repairs.',
  seats: [{ role: 'peer', count: 3 }],
  phases: [
    {
      id: 'plan',
      intent: 'Agree the contract and a split.',
      writes: 'no-source',
      gates: [
        { id: 'contract-exists', by: 'workspace', quorum: 'any' },
        { id: 'split-agreed', by: 'asserted', quorum: 'all' },
      ],
    },
    {
      id: 'build',
      intent: 'Build your own files.',
      writes: 'own-files',
      gates: [{ id: 'self-verified', by: 'asserted', quorum: 'all' }],
    },
  ],
};

const SOLO: ShapeSummary = {
  name: 'solo',
  summary: 'One builder, verifying its own work.',
  seats: [{ role: 'peer', count: 1 }],
  phases: [{ id: 'build', intent: 'Build it.', writes: 'anything', gates: [] }],
};

describe('staffing a shape', () => {
  it('gives every seat in the shape a distinct name', () => {
    expect(seatsFor(TRIO).map((seat) => seat.id)).toEqual(['peer-1', 'peer-2', 'peer-3']);
  });

  it('does not number a shape with one seat', () => {
    expect(seatsFor(SOLO).map((seat) => seat.id)).toEqual(['peer']);
  });

  it('finds names that collide, because the board addresses a seat by its name', () => {
    expect(clashingIds([
      { id: 'a', role: 'peer', harness: 'x', model: 'm', effort: 'high' },
      { id: 'a', role: 'peer', harness: 'x', model: 'm', effort: 'high' },
    ])).toEqual(['a']);
  });
});

describe('the launcher', () => {
  it('staffs the roster from the shape as soon as one is picked', () => {
    render(createElement(Launcher, { shapes: [TRIO, SOLO], onLaunch: async () => ({ ok: true as const }) }));

    fireEvent.click(screen.getByText('trio-contract'));

    expect((screen.getByLabelText('seat 1 name') as unknown as { value: string }).value).toBe('peer-1');
    expect((screen.getByLabelText('seat 3 name') as unknown as { value: string }).value).toBe('peer-3');
  });

  it('shows what the shape will hold the team to before it costs anything', () => {
    render(createElement(Launcher, { shapes: [TRIO], onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    // A workspace gate is checked against the repo; an asserted one is a claim.
    // Showing both, labelled, stops a self-report reading as a check.
    expect(screen.getByText(/contract-exists/)).toBeTruthy();
    expect(screen.getByText(/self-verified · all/)).toBeTruthy();
  });

  it('will not start without a job, however well staffed', () => {
    render(createElement(Launcher, { shapes: [TRIO], onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    expect((screen.getByText('Start the run') as unknown as { disabled: boolean }).disabled).toBe(true);
  });

  it('refuses to start two seats with the same name, and says which', () => {
    render(createElement(Launcher, { shapes: [TRIO], onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.change(screen.getByLabelText('seat 2 name'), { target: { value: 'peer-1' } });

    expect(screen.getByText(/Two seats are called peer-1/)).toBeTruthy();
    expect((screen.getByText('Start the run') as unknown as { disabled: boolean }).disabled).toBe(true);
  });

  /**
   * The pickers have to reach the seats. This test used to assert the opposite
   * — that only `id:role:harness` was sent — which made the model and effort
   * controls decorative: the seats launched on whatever the roster defaulted
   * to, and nothing in the hub said so.
   */
  it('sends the roster in the spelling init takes, models and effort included', async () => {
    const onLaunch = vi.fn(async (_request: { job: string; shape?: string; seats: string[] }) => ({ ok: true as const }));
    render(createElement(Launcher, { shapes: [TRIO], onLaunch }));

    fireEvent.click(screen.getByText('trio-contract'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByText('Start the run'));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(onLaunch.mock.calls[0]![0]).toEqual({
      job: 'build a vault',
      shape: 'trio-contract',
      seats: [
        'peer-1:peer:claude-code-live:claude-opus-5:high',
        'peer-2:peer:claude-code-live:claude-opus-5:high',
        'peer-3:peer:claude-code-live:claude-opus-5:high',
      ],
    });
  });

  it('omits a model and effort nobody chose, rather than sending empty fields', async () => {
    const onLaunch = vi.fn(async (_request: { job: string; shape?: string; seats: string[] }) => ({ ok: true as const }));
    render(createElement(Launcher, { shapes: [TRIO], onLaunch }));

    fireEvent.click(screen.getByText('trio-contract'));
    fireEvent.change(screen.getByLabelText('seat 1 model'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('seat 1 effort'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByText('Start the run'));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    // A trailing `:` would write `model: ""` into the roster, which renders as a
    // blank beside the seat and reads as a configured value rather than as
    // "nobody said".
    expect(onLaunch.mock.calls[0]![0].seats[0]).toBe('peer-1:peer:claude-code-live');
  });

  it('keeps a hand-edited roster when the shape is clicked again', () => {
    render(createElement(Launcher, { shapes: [TRIO, SOLO], onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));
    fireEvent.change(screen.getByLabelText('seat 1 name'), { target: { value: 'renderer' } });

    fireEvent.click(screen.getByText('solo'));

    // Re-staffing here would silently throw away chosen names and models.
    expect((screen.getByLabelText('seat 1 name') as unknown as { value: string }).value).toBe('renderer');
  });

  it('carries the daemon’s refusal back to the operator instead of failing quietly', async () => {
    render(
      createElement(Launcher, {
        shapes: [TRIO],
        onLaunch: async () => ({ ok: false as const, reason: 'no shape named trio-contract' }),
      }),
    );
    fireEvent.click(screen.getByText('trio-contract'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByText('Start the run'));

    await waitFor(() => expect(screen.getByText('no shape named trio-contract')).toBeTruthy());
  });

  it('says how many seats can be watched from a phone', () => {
    render(createElement(Launcher, { shapes: [TRIO], onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    expect(screen.getByText('3 watchable from your phone')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('seat 1 CLI'), { target: { value: 'codex-cli' } });
    expect(screen.getByText('2 watchable from your phone')).toBeTruthy();
  });
});
