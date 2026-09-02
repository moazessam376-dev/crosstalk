// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Launcher, seatsFor, clashingIds } from '../../src/ui/launch/Launcher.js';
import type { ShapeSummary } from '../../src/ui/state/useLaunch.js';

afterEach(cleanup);

function textOf(element: Element): string {
  return (element as unknown as { textContent: string }).textContent;
}

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

/**
 * The launcher is a page and has to scroll like one.
 *
 * `.hub-root` is `height: 100dvh; overflow: hidden`, and the board's three
 * regions each scroll inside themselves. The launcher is not one of them, so
 * with only the centred column there was no scroll container anywhere: staff
 * more than about three seats and the job box and the button that starts the
 * run were clipped off the bottom of the window, unreachable.
 *
 * jsdom computes no layout, so what is pinned here is the structure the fix
 * depends on rather than the scrolling itself — the scroller must be the
 * outermost element, so the scrollbar lands at the window edge and not inside
 * the 940px column.
 */
describe('the launcher as a page', () => {
  it('wraps its centred column in a full-width scroller', () => {
    const { container } = render(
      createElement(Launcher, { shapes: [TRIO], onLaunch: async () => ({ ok: true as const }) }),
    );

    // The frozen test config omits the `dom` lib, so the element shape this
    // assertion needs is named rather than inherited.
    const outer = (container as unknown as {
      firstElementChild: {
        className: string;
        firstElementChild: { getAttribute(name: string): string | null } | null;
      } | null;
    }).firstElementChild;

    expect(outer?.className).toBe('launcher-scroll');
    expect(outer?.firstElementChild?.getAttribute('data-testid')).toBe('launcher');
  });
});

/**
 * Every model this account can actually run has to be pickable.
 *
 * The list is hand-written in the launcher, and `claude-fable-5` was missed
 * when it was — so a seat could not be put on it from the hub at all, and the
 * operator found out by opening the dropdown and not seeing it.
 */
/**
 * What `GET /harnesses` serves, including which harnesses are watchable.
 *
 * `watchable` is a fact the registry holds — an interactive `turnFormat` — and
 * the launcher used to guess it from a `-live` suffix on the key, which is a
 * naming convention rather than a contract.
 */
const CATALOG = [
  {
    id: 'claude-code-live',
    label: 'Claude Code · interactive',
    models: ['claude-opus-5', 'claude-fable-5'],
    watchable: true,
  },
  { id: 'codex-cli', label: 'Codex', models: ['gpt-5.6-luna', 'gpt-5.6-terra'], watchable: false },
];

/**
 * The options a field offers.
 *
 * The model and effort fields are typeable now — a closed list offered
 * `gpt-5.3-codex` to an operator whose Codex runs luna, terra and sol, and a
 * model missing from the list could not be chosen at all. So the options live
 * in the `datalist` the input names, and a `select` is still read the old way
 * for the fields that are genuinely closed.
 */
function optionsOf(label: string): (string | null)[] {
  const picker = screen.getByLabelText(label) as unknown as {
    tagName: string;
    getAttribute(name: string): string | null;
    querySelectorAll(selector: string): { getAttribute(name: string): string | null }[];
    parentElement: { querySelectorAll(selector: string): { getAttribute(name: string): string | null }[] } | null;
  };
  const own = [...picker.querySelectorAll('option')];
  if (own.length > 0) return own.map((option) => option.getAttribute('value'));
  const suggestions = picker.parentElement?.querySelectorAll('datalist option') ?? [];
  return [...suggestions].map((option) => option.getAttribute('value'));
}

/**
 * Which harnesses exist and what each can run are properties of the binaries,
 * not of the hub. Both were hard-coded here, so a Codex seat was offered Claude
 * models and `claude-fable-5` could not be chosen at all — nobody had added it
 * to an array in a React file. They now come from the harness registry.
 */
describe('the model picker', () => {
  it('offers the models of the harness the seat is on', () => {
    render(createElement(Launcher, { shapes: [TRIO], catalog: CATALOG, onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    expect(optionsOf('seat 1 model')).toContain('claude-fable-5');
    expect(optionsOf('seat 1 model')).not.toContain('gpt-5.6-luna');
  });

  it('offers a different harness a different set', () => {
    render(createElement(Launcher, { shapes: [TRIO], catalog: CATALOG, onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    fireEvent.change(screen.getByLabelText('seat 1 CLI'), { target: { value: 'codex-cli' } });

    expect(optionsOf('seat 1 model')).toContain('gpt-5.6-luna');
    expect(optionsOf('seat 1 model')).not.toContain('claude-opus-5');
  });

  /** A model the new harness cannot run must not survive the switch. */
  it('drops a model the new harness cannot run', async () => {
    const onLaunch = vi.fn(async (_r: { job: string; shape?: string; seats: string[] }) => ({ ok: true as const }));
    render(createElement(Launcher, { shapes: [TRIO], catalog: CATALOG, onLaunch }));
    fireEvent.click(screen.getByText('trio-contract'));

    fireEvent.change(screen.getByLabelText('seat 1 CLI'), { target: { value: 'codex-cli' } });
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByText('Start the run'));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(onLaunch.mock.calls[0]![0].seats[0]).not.toContain('claude-opus-5');
  });

  it('names the CLIs from the registry too', () => {
    render(createElement(Launcher, { shapes: [TRIO], catalog: CATALOG, onLaunch: async () => ({ ok: true as const }) }));
    fireEvent.click(screen.getByText('trio-contract'));

    expect(optionsOf('seat 1 CLI')).toEqual(['claude-code-live', 'codex-cli']);
  });
});


/**
 * A planner and however many builders.
 *
 * The operator's question was "I don't see where the option to run with a
 * planner and a number of agents?". Their daemon predated the shape, so the
 * card was genuinely absent — but behind that sat a real gap: `SeatSpec.varies`
 * never left the daemon, so even with the card there the hub would have laid
 * out exactly three builders and offered no way to say otherwise.
 */
const PLANNER: ShapeSummary = {
  name: 'planner-integrator',
  summary: 'One planner who splits and merges; builders who build their own slice.',
  seats: [
    { role: 'leader', count: 1 },
    { role: 'worker', count: 3, varies: true },
  ],
  phases: [
    {
      id: 'plan',
      intent: 'Ask the operator, then split the work.',
      writes: 'no-source',
      // `by: 'log'` is the value the type used to say could not exist.
      gates: [{ id: 'operator-questioned', by: 'log', quorum: 'any' }],
    },
  ],
};

describe('a planner and a number of builders', () => {
  it('lays out the shape it is given, leader included', () => {
    expect(seatsFor(PLANNER).map((seat) => seat.id)).toEqual(['leader', 'worker-1', 'worker-2', 'worker-3']);
    // A single seat is unnumbered; three are numbered. Both in one shape.
    expect(seatsFor(PLANNER).map((seat) => seat.role)).toEqual(['leader', 'worker', 'worker', 'worker']);
  });

  it('lays out as many builders as asked for', () => {
    expect(seatsFor(PLANNER, [], 5).map((seat) => seat.id)).toEqual([
      'leader',
      'worker-1',
      'worker-2',
      'worker-3',
      'worker-4',
      'worker-5',
    ]);
    // One builder drops the number, like any other single seat.
    expect(seatsFor(PLANNER, [], 1).map((seat) => seat.id)).toEqual(['leader', 'worker']);
    // And the count only touches the seat that varies.
    expect(seatsFor(TRIO, [], 5).map((seat) => seat.id)).toEqual(['peer-1', 'peer-2', 'peer-3']);
  });

  it('offers the stepper only where the shape says the count varies', () => {
    const { rerender } = render(
      createElement(Launcher, { shapes: [PLANNER, TRIO], launching: false, onLaunch: vi.fn() }),
    );
    fireEvent.click(screen.getByText('trio-contract'));
    expect(screen.queryByTestId('seat-count')).not.toBeInTheDocument();

    rerender(createElement(Launcher, { shapes: [PLANNER, TRIO], launching: false, onLaunch: vi.fn() }));
    fireEvent.click(screen.getByText('planner-integrator'));
    expect(screen.getByTestId('seat-count')).toBeInTheDocument();
  });

  it('restaffs when the number changes, and launches that many', async () => {
    const onLaunch = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(Launcher, { shapes: [PLANNER], launching: false, onLaunch }));
    fireEvent.click(screen.getByText('planner-integrator'));
    fireEvent.click(screen.getByLabelText('5 workers'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the run' }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    const seats = (onLaunch.mock.calls[0]![0] as { seats: string[] }).seats;
    expect(seats.filter((seat) => seat.startsWith('worker-'))).toHaveLength(5);
    expect(seats.filter((seat) => seat.startsWith('leader'))).toHaveLength(1);
  });

  it('adds the shape\'s own worker role, not a peer', async () => {
    // `runInit` refuses "a roster is led or flat, not both", so a led roster
    // that grew by a `peer` was a roster the button had made unlaunchable.
    const onLaunch = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(Launcher, { shapes: [PLANNER], launching: false, onLaunch }));
    fireEvent.click(screen.getByText('planner-integrator'));
    fireEvent.click(screen.getByText('Add a seat'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the run' }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    const seats = (onLaunch.mock.calls[0]![0] as { seats: string[] }).seats;
    expect(seats.some((seat) => seat.includes(':peer:'))).toBe(false);
    expect(seats.filter((seat) => seat.includes(':worker:'))).toHaveLength(4);
  });
});

describe('the stepper against a daemon that already has seats', () => {
  /**
   * The case the first version of these tests missed entirely.
   *
   * `seatsFor` returns the live roster verbatim when there is one, ignoring the
   * shape — deliberately, so a launch cannot name seats whose tokens do not
   * exist. But that made the stepper inert exactly when it is most likely to be
   * used: clicking 5 highlighted 5 and left two seats on screen. Found by
   * building it and clicking it; every unit test here passed throughout,
   * because they all passed an empty `running`.
   */
  const RUNNING = [
    { id: 'planner', role: 'leader', harness: 'claude-code-live', model: null, effort: null,
      workspace: '.', present: true, activity: null, remoteControl: null, mirrored: true },
    { id: 'builder', role: 'worker', harness: 'claude-code-live', model: null, effort: null,
      workspace: '.', present: true, activity: null, remoteControl: null, mirrored: true },
  ];

  it('still shows the live roster until the number is changed', () => {
    render(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch: vi.fn(), running: RUNNING,
      }),
    );
    fireEvent.click(screen.getByText('planner-integrator'));
    expect(screen.getByDisplayValue('planner')).toBeInTheDocument();
    expect(screen.getByDisplayValue('builder')).toBeInTheDocument();
  });

  it('re-lays the roster when the number changes, live seats or not', async () => {
    const onLaunch = vi.fn().mockResolvedValue({ ok: true });
    render(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch, running: RUNNING,
      }),
    );
    fireEvent.click(screen.getByText('planner-integrator'));
    fireEvent.click(screen.getByLabelText('5 workers'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the run' }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    const seats = (onLaunch.mock.calls[0]![0] as { seats: string[] }).seats;
    expect(seats.filter((seat) => seat.includes(':worker:'))).toHaveLength(5);
  });
});

describe('starting a run over one that is still going', () => {
  /**
   * The operator asked what happens if they start a run while one is live and
   * guessed things would break. The daemon now refuses, but a refusal the
   * operator only meets *after* pressing Start is a bad way to learn that
   * pressing Start kills three agents. The button says so first.
   */
  const seat = (id: string, live: boolean) => ({
    id, role: 'worker', harness: 'claude-code-live', model: null, effort: null,
    workspace: '.', present: true, activity: null, remoteControl: null, mirrored: true, live,
  });

  it('says whose processes it will stop, by name', () => {
    render(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch: vi.fn(),
        running: [seat('planner', true), seat('builder', true)],
      }),
    );

    expect(screen.getByRole('button', { name: 'End current run & start' })).toBeInTheDocument();
    // Named, not counted: "2 seats will be stopped" is not something an
    // operator can check against what they believe is running.
    // The repo's tsconfig omits the `dom` lib on purpose, so `textContent` is
    // reached through a named cast, as in `message-card.test.tsx`.
    const warning = textOf(screen.getByTestId('launch-warning'));
    expect(warning).toContain('planner');
    expect(warning).toContain('builder');
    // And it says what stopping does *not* do, because that is the part they
    // would otherwise have to find out by losing a diff.
    expect(warning).toContain('worktrees');
  });

  it('does not count a seat whose process has already exited', () => {
    // `mirrored` stays true for a dead seat on purpose — the mirror shows the
    // screen it died on. Reading that as "still running" would put the scary
    // button on every launcher for the rest of the daemon's life.
    render(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch: vi.fn(),
        running: [seat('planner', false), seat('builder', false)],
      }),
    );

    expect(screen.getByRole('button', { name: 'Start the run' })).toBeInTheDocument();
    expect(screen.queryByTestId('launch-warning')).toBeNull();
  });

  it('sends end only when something is actually live', async () => {
    const onLaunch = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch, running: [seat('planner', true)],
      }),
    );
    fireEvent.click(screen.getByText('planner-integrator'));
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'End current run & start' }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect((onLaunch.mock.calls[0]![0] as { end?: boolean }).end).toBe(true);

    // And the other way: a blanket `end: true` would make the daemon's refusal
    // unreachable, which is the guard's entire job.
    onLaunch.mockClear();
    rerender(
      createElement(Launcher, {
        shapes: [PLANNER], launching: false, onLaunch, running: [seat('planner', false)],
      }),
    );
    fireEvent.change(screen.getByLabelText('the job'), { target: { value: 'build a vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the run' }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect((onLaunch.mock.calls[0]![0] as { end?: boolean }).end).toBeUndefined();
  });
});
