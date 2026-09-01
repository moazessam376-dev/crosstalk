import { createElement as h, useMemo, useState } from 'react';
import type { SeatSession, ShapeSummary } from '../state/useLaunch.js';
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
  /**
   * The seats this daemon is running, from `GET /sessions`.
   *
   * Not decoration: a seat's id, role and harness are fixed when the daemon
   * starts, so a launch naming any other roster is refused. This is what the
   * form arrives filled with.
   */
  running?: readonly SeatSession[];
  shapes: ShapeSummary[];
  /** From `GET /harnesses`: what exists, and what each one runs. */
  catalog?: readonly {
    id: string;
    label: string;
    models: string[];
    /** Richer than `models` where the binary answered: labels and efforts. */
    catalogue?: readonly { id: string; label: string; efforts?: string[] }[];
    modelSource?: string;
    /** Whether a seat on this harness gets a mirrored terminal. */
    watchable?: boolean;
  }[];
  launching?: boolean;
  onLaunch: (request: { job: string; shape?: string; seats: string[] }) => Promise<PostResult>;
}

/**
 * What to show before `GET /harnesses` answers, and if it never does.
 *
 * The real list comes from the harness registry — which harnesses exist and
 * what each can be put on are properties of the binaries, not of this file.
 * Hard-coding them here meant a Codex seat was offered Claude models, and a
 * model nobody had added to this array could not be chosen at all: that is how
 * `claude-fable-5` went missing.
 */
const FALLBACK_HARNESSES: NonNullable<LauncherProps['catalog']> = [
  // Watchable, because it is: this entry is the interactive Claude Code
  // harness, and a fallback that understated what it is would make the hub
  // claim fewer watchable seats than it has.
  { id: 'claude-code-live', label: 'Claude Code · interactive', models: [], watchable: true },
];

/**
 * Efforts to offer when the harness did not say which it takes.
 *
 * Codex names its own — and names more than these: `xhigh`, `max`, `ultra`.
 * Anything discovered replaces this list, and the field is typeable either way,
 * because a fixed vocabulary is the same mistake as a fixed model list.
 */
const EFFORTS = ['high', 'medium', 'low'];

/**
 * The roster to arrive with.
 *
 * Prefers the seats this daemon is **actually running** over the shape's
 * abstract ones, and that is load-bearing rather than a nicety. A seat's id,
 * role and harness are fixed when the daemon starts, because that is when its
 * token is minted — so a launch naming seats the daemon never seated is
 * refused. Filling the form with `peer-1, peer-2, peer-3` against a repo
 * seated with `opus, codex, rigit` meant the default action on this screen
 * always failed.
 *
 * The shape's own seats are the fallback, for a hub whose daemon has not
 * reported a roster yet.
 */
export function seatsFor(shape: ShapeSummary | undefined, running: readonly SeatSession[] = []): SeatDraft[] {
  const seated = running.filter((seat) => seat.role !== 'human');
  if (seated.length > 0) {
    return seated.map((seat) => ({
      id: seat.id,
      role: seat.role,
      harness: seat.harness,
      model: seat.model ?? '',
      effort: seat.effort ?? '',
    }));
  }

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

/**
 * A text field with suggestions, rather than a closed list.
 *
 * `datalist` is the whole mechanism: the operator gets the discovered models as
 * a dropdown and can still type one that is not there. No React state, no
 * combobox to keep open, and it degrades to a plain text input in anything that
 * does not support it — which is the correct failure for a field whose contract
 * is "free text".
 */
function suggested(
  label: string,
  listId: string,
  value: string,
  options: readonly string[],
  onChange: (value: string) => void,
): ReturnType<typeof h> {
  return h(
    'span',
    { className: 'seat-suggest' },
    h('input', {
      'aria-label': label,
      list: options.length > 0 ? listId : undefined,
      value,
      autoComplete: 'off',
      spellCheck: false,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
    options.length === 0
      ? null
      : h(
          'datalist',
          { id: listId },
          options.map((option) => h('option', { key: option, value: option })),
        ),
  );
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

export function Launcher({ shapes, launching, onLaunch, running = [], catalog }: LauncherProps) {
  const harnesses = catalog !== undefined && catalog.length > 0 ? catalog : FALLBACK_HARNESSES;
  /** The models the harness this seat is on can actually run. */
  const modelsFor = (harness: string): string[] =>
    harnesses.find((entry) => entry.id === harness)?.models ?? [];

  /** The efforts the chosen model accepts, when the binary said. */
  const effortsFor = (harness: string, model: string): string[] => {
    const entry = harnesses.find((candidate) => candidate.id === harness);
    const found = entry?.catalogue?.find((candidate) => candidate.id === model);
    return found?.efforts !== undefined && found.efforts.length > 0 ? [...found.efforts] : EFFORTS;
  };
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
    if (!touched) setSeats(seatsFor(shapes.find((entry) => entry.name === name), running));
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
      // `id:role:harness[:model[:effort]]` — the same spec `--participant`
      // takes. Sending only the first three made the model and effort pickers
      // decorative: the seats launched on whatever the roster defaulted to,
      // and the operator had no way to tell from the hub.
      //
      // Effort is positional and last, so a seat with an effort and no model
      // has to send an empty model field rather than drop it.
      seats: seats.map((seat) => {
        const parts = [seat.id, seat.role, seat.harness];
        if (seat.model !== '' || seat.effort !== '') parts.push(seat.model);
        if (seat.effort !== '') parts.push(seat.effort);
        return parts.join(':');
      }),
    });
    if (!result.ok) setError(result.reason);
    else setJob('');
  };

  // Asked of the catalogue, not pattern-matched off the key: `-live` is a
  // naming convention and this was reading it as a contract, so a watchable
  // harness named anything else would have been counted as unwatchable.
  const watchable = seats.filter(
    (seat) => harnesses.find((entry) => entry.id === seat.harness)?.watchable === true,
  ).length;

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
          onChange: (event: { target: { value: string } }) => {
            const harness = event.target.value;
            // A model belongs to the harness it runs on, so switching CLI drops
            // a model the new one cannot run rather than sending a Codex seat
            // to claude-opus-5. A model the list has never heard of is kept:
            // the list is a suggestion now, and discarding what the operator
            // typed because we do not recognise it is the old bug wearing new
            // clothes.
            const known = modelsFor(seat.harness).includes(seat.model);
            const keep = !known || modelsFor(harness).includes(seat.model) ? seat.model : '';
            editSeat(index, { harness, model: keep });
          },
        },
        harnesses,
      ),
      // Typeable, with the discovered list as suggestions. A hard-coded list
      // offered `gpt-5.3-codex` to an operator whose Codex runs luna, terra and
      // sol — and a model missing from the list could not be chosen at all.
      // `model` is free text by contract; this is the field agreeing with it.
      suggested(`seat ${index + 1} model`, `models-${index}`, seat.model, modelsFor(seat.harness), (value) =>
        editSeat(index, { model: value }),
      ),
      suggested(
        `seat ${index + 1} effort`,
        `efforts-${index}`,
        seat.effort,
        effortsFor(seat.harness, seat.model),
        (value) => editSeat(index, { effort: value }),
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

  // Two elements, not one. The scroller has to be the full-width child of
  // `.hub-root` — which is `height: 100dvh; overflow: hidden` — while the
  // content stays a centred column. With only the centred element there was no
  // scroll container at all: the board's regions each scroll internally and the
  // launcher is not one of them, so a roster of more than about three seats was
  // simply clipped at the bottom of the window with no way to reach it.
  return h(
    'div',
    { className: 'launcher-scroll' },
    h(
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
    ),
  );
}
