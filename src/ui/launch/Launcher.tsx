import { createElement as h, useMemo, useState } from 'react';
import type { ShapeSummary } from '../state/useLaunch.js';
import type { PostResult } from '../state/humanAction.js';

/** One row of the roster the operator is assembling. */
export interface SeatDraft {
  id: string;
  role: string;
  harness: string;
  model: string;
  effort: string;
}

export interface LauncherProps {
  shapes: ShapeSummary[];
  launching?: boolean;
  onLaunch: (request: { job: string; shape?: string; seats: string[] }) => Promise<PostResult>;
}

const HARNESSES = [
  { id: 'claude-code-live', label: 'Claude Code · interactive' },
  { id: 'claude-code-cli', label: 'Claude Code · headless' },
  { id: 'codex-cli', label: 'Codex' },
  { id: 'cursor-cli', label: 'Cursor' },
];

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const EFFORTS = ['high', 'medium', 'low'];

/** Names seats after the shape, so the roster is never empty on arrival. */
export function seatsFor(shape: ShapeSummary | undefined): SeatDraft[] {
  if (shape === undefined) return [];
  const drafts: SeatDraft[] = [];
  for (const spec of shape.seats) {
    for (let index = 0; index < spec.count; index += 1) {
      drafts.push({
        id: spec.count === 1 ? spec.role : `${spec.role}-${index + 1}`,
        role: spec.role,
        harness: 'claude-code-live',
        model: 'claude-opus-5',
        effort: 'high',
      });
    }
  }
  return drafts;
}

/** Seat names must be unique: the board addresses a seat by its name. */
export function clashingIds(seats: readonly SeatDraft[]): string[] {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const seat of seats) {
    if (seen.has(seat.id)) clashes.add(seat.id);
    seen.add(seat.id);
  }
  return [...clashes];
}

function field(
  kind: 'input' | 'select',
  props: Record<string, unknown>,
  options?: readonly string[] | readonly { id: string; label: string }[],
): ReturnType<typeof h> {
  if (kind === 'input') return h('input', props);
  return h(
    'select',
    props,
    (options ?? []).map((option) =>
      typeof option === 'string'
        ? h('option', { key: option, value: option }, option)
        : h('option', { key: option.id, value: option.id }, option.label),
    ),
  );
}

export function Launcher({ shapes, launching, onLaunch }: LauncherProps) {
  const [shapeName, setShapeName] = useState<string | undefined>();
  const [job, setJob] = useState('');
  const [seats, setSeats] = useState<SeatDraft[]>([]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const shape = useMemo(() => shapes.find((entry) => entry.name === shapeName), [shapes, shapeName]);
  const clashes = useMemo(() => clashingIds(seats), [seats]);

  const chooseShape = (name: string): void => {
    setShapeName(name);
    // Only replace a roster the operator has not edited. Losing hand-picked
    // models because a shape was re-clicked would be its own small betrayal.
    if (!touched) setSeats(seatsFor(shapes.find((entry) => entry.name === name)));
  };

  const editSeat = (index: number, patch: Partial<SeatDraft>): void => {
    setTouched(true);
    setSeats((current) => current.map((seat, at) => (at === index ? { ...seat, ...patch } : seat)));
  };

  const ready =
    job.trim() !== '' && seats.length > 0 && clashes.length === 0
    && seats.every((seat) => seat.id.trim() !== '');

  const start = async (): Promise<void> => {
    setError(undefined);
    const result = await onLaunch({
      job: job.trim(),
      ...(shapeName === undefined ? {} : { shape: shapeName }),
      seats: seats.map((seat) => `${seat.id}:${seat.role}:${seat.harness}`),
    });
    if (!result.ok) setError(result.reason);
    else setJob('');
  };

  const watchable = seats.filter((seat) => seat.harness.endsWith('-live')).length;

  const shapeCards = shapes.map((entry) =>
    h(
      'button',
      {
        key: entry.name,
        type: 'button',
        className: `shape-card${entry.name === shapeName ? ' is-chosen' : ''}`,
        'aria-pressed': entry.name === shapeName,
        onClick: () => chooseShape(entry.name),
      },
      h('span', { className: 'shape-name' }, entry.name),
      h('span', { className: 'shape-summary' }, entry.summary),
      h('span', { className: 'shape-phases' }, entry.phases.map((phase) => phase.id).join(' → ')),
    ),
  );

  const gateRows = (shape?.phases ?? []).map((phase) =>
    h(
      'li',
      { key: phase.id },
      h('span', { className: 'gate-phase' }, phase.id),
      h('span', { className: 'gate-intent' }, phase.intent),
      h(
        'span',
        { className: 'gate-ids' },
        phase.gates.map((gate) =>
          h(
            'span',
            { key: gate.id, className: `gate-chip is-${gate.by}` },
            `${gate.id}${gate.quorum === 'all' ? ' · all' : ''}`,
          ),
        ),
      ),
    ),
  );

  const seatRows = seats.map((seat, index) =>
    h(
      'div',
      { className: `seat-row${clashes.includes(seat.id) ? ' is-clash' : ''}`, key: index },
      field('input', {
        'aria-label': `seat ${index + 1} name`,
        value: seat.id,
        onChange: (event: { target: { value: string } }) => editSeat(index, { id: event.target.value }),
      }),
      field('input', {
        'aria-label': `seat ${index + 1} role`,
        value: seat.role,
        onChange: (event: { target: { value: string } }) => editSeat(index, { role: event.target.value }),
      }),
      field(
        'select',
        {
          'aria-label': `seat ${index + 1} CLI`,
          value: seat.harness,
          onChange: (event: { target: { value: string } }) => editSeat(index, { harness: event.target.value }),
        },
        HARNESSES,
      ),
      field(
        'select',
        {
          'aria-label': `seat ${index + 1} model`,
          value: seat.model,
          onChange: (event: { target: { value: string } }) => editSeat(index, { model: event.target.value }),
        },
        MODELS,
      ),
      field(
        'select',
        {
          'aria-label': `seat ${index + 1} effort`,
          value: seat.effort,
          onChange: (event: { target: { value: string } }) => editSeat(index, { effort: event.target.value }),
        },
        EFFORTS,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'seat-drop',
          'aria-label': `remove seat ${seat.id}`,
          onClick: () => {
            setTouched(true);
            setSeats((current) => current.filter((_, at) => at !== index));
          },
        },
        '✕',
      ),
    ),
  );

  return h(
    'div',
    { className: 'launcher', 'data-testid': 'launcher' },
    h(
      'header',
      { className: 'launcher-head' },
      h('h1', null, 'Start a run'),
      h('p', null, 'Pick how the team works, who sits in it, and what they are building.'),
    ),

    h(
      'section',
      { className: 'launcher-section' },
      h('h2', null, 'Shape'),
      h('div', { className: 'shape-grid' }, shapeCards),
    ),

    shape === undefined
      ? null
      : h(
          'section',
          { className: 'launcher-section' },
          h('h2', null, 'What it holds them to'),
          h('ol', { className: 'gate-list' }, gateRows),
        ),

    h(
      'section',
      { className: 'launcher-section' },
      h(
        'h2',
        null,
        'Seats',
        watchable > 0 ? h('span', { className: 'seat-note' }, `${watchable} watchable from your phone`) : null,
      ),
      h(
        'div',
        { className: 'seat-table' },
        h(
          'div',
          { className: 'seat-row seat-head' },
          h('span', null, 'Name'),
          h('span', null, 'Role'),
          h('span', null, 'CLI'),
          h('span', null, 'Model'),
          h('span', null, 'Effort'),
          h('span', null),
        ),
        seatRows,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'seat-add',
          onClick: () => {
            setTouched(true);
            setSeats((current) => [
              ...current,
              {
                id: `peer-${current.length + 1}`,
                role: 'peer',
                harness: 'claude-code-live',
                model: 'claude-opus-5',
                effort: 'high',
              },
            ]);
          },
        },
        'Add a seat',
      ),
      clashes.length === 0
        ? null
        : h(
            'p',
            { className: 'launcher-error' },
            `Two seats are called ${clashes.join(', ')}. Every seat needs its own name — the board addresses them by it.`,
          ),
    ),

    h(
      'section',
      { className: 'launcher-section' },
      h('h2', null, 'The job'),
      h('textarea', {
        className: 'job-box',
        'aria-label': 'the job',
        rows: 8,
        placeholder: 'What are they building? Say what done looks like, and how it should be verified.',
        value: job,
        onChange: (event: { target: { value: string } }) => setJob(event.target.value),
      }),
    ),

    error === undefined ? null : h('p', { className: 'launcher-error' }, error),

    h(
      'div',
      { className: 'launcher-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'launch-go',
          disabled: !ready || launching === true,
          onClick: () => void start(),
        },
        launching === true ? 'Starting…' : 'Start the run',
      ),
      h(
        'span',
        { className: 'launch-hint' },
        `${seats.length} ${seats.length === 1 ? 'seat' : 'seats'}${shapeName === undefined ? ' · no shape' : ` · ${shapeName}`}`,
      ),
    ),
  );
}
