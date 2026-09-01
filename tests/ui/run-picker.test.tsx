// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { RunPicker, runLabel } from '../../src/ui/layout/RunPicker.js';
import type { RunSummary } from '../../src/core/runs.js';

afterEach(cleanup);

/**
 * Where the operator gets at their runs.
 *
 * The complaint this whole workstream answers was "every time I access
 * crosstalk I get the last session's stuff" — and the second half of it was
 * "I want sessions that I can either delete, archive, put away and start a new
 * run". The boundary makes the board show one run; this is the surface where
 * they choose which, and where the one irreversible act in the hub lives.
 */

/**
 * Fixtures are dated relative to the real clock on purpose.
 *
 * `runLabel` says "today" and "yesterday", which are facts about when the test
 * runs, not about a literal in it. A hard-coded ISO string passes in September
 * 2026 and fails every day after — the kind of green that stops meaning
 * anything. Calendar arithmetic, so it holds across a midnight boundary too.
 */
function atLocal(daysAgo: number, hour: number, minute: number): string {
  const when = new Date();
  when.setDate(when.getDate() - daysAgo);
  when.setHours(hour, minute, 0, 0);
  return when.toISOString();
}

function run(over: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    startedAt: atLocal(0, 14, 12),
    firstSeq: 1,
    events: 12,
    archived: false,
    current: false,
    ...over,
  };
}

const CURRENT = run({ id: 'r-20260902-1412-a3f1c9', current: true, events: 12 });
const OLDER = run({ id: 'r-20260901-0904-b7d210', events: 1187, startedAt: atLocal(1, 9, 4) });
const ARCHIVED = run({
  id: 'r-20260831-2152-cc0091',
  events: 400,
  archived: true,
  startedAt: atLocal(2, 21, 52),
});

describe('the run picker', () => {
  it('names the run being shown, not just its id', () => {
    // An id is for a path; a person reads a time.
    const at = new Date(2026, 8, 2, 15, 0, 0);
    expect(runLabel({ ...CURRENT, startedAt: new Date(2026, 8, 2, 14, 12).toISOString() }, at)).toBe('today 14:12');
    expect(runLabel({ ...OLDER, startedAt: new Date(2026, 8, 1, 9, 4).toISOString() }, at)).toBe('yesterday 09:04');
    expect(runLabel({ ...ARCHIVED, startedAt: new Date(2026, 7, 31, 21, 52).toISOString() }, at)).toBe('31 Aug 21:52');
    // A run whose timestamp never parsed still has to render something.
    expect(runLabel({ ...CURRENT, startedAt: 'not a date' }, at)).toBe(CURRENT.id);
  });

  it('lists every run once opened, and says which is live', () => {
    render(createElement(RunPicker, { runs: [CURRENT, OLDER, ARCHIVED] }));
    // Closed by default: it is navigation, not a panel that eats the sidebar.
    expect(screen.queryByText('Start a new run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('1187 events')).toBeInTheDocument();
    expect(screen.getByText('400 events \u00b7 archived')).toBeInTheDocument();
  });

  it('offers archive only for a run that is neither current nor already archived', () => {
    // Archiving the run being written to is the one that would corrupt
    // something, so the button is not there to be clicked.
    render(createElement(RunPicker, { runs: [CURRENT, OLDER, ARCHIVED] }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getAllByText('Archive')).toHaveLength(1);
  });

  it('makes deleting ask for the id, not for a click', () => {
    const onDelete = vi.fn();
    render(createElement(RunPicker, { runs: [CURRENT, ARCHIVED], onDelete }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('Delete'));

    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    expect(onDelete).not.toHaveBeenCalled();

    // The wrong id does not arm it either.
    fireEvent.change(screen.getByLabelText('run id to confirm'), { target: { value: 'r-nope' } });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('run id to confirm'), { target: { value: ARCHIVED.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(ARCHIVED.id);
  });

  it('reports the current run as undefined, so the board goes back to live', () => {
    // Two different things: "show me run X" and "go back to whatever is live".
    // Passing the current run's id as a selection would pin the board to a run
    // that is still being written, and it would stop following it.
    const onView = vi.fn();
    render(createElement(RunPicker, { runs: [CURRENT, OLDER], onView }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    fireEvent.click(screen.getByText('yesterday 09:04'));
    expect(onView).toHaveBeenCalledWith(OLDER.id);

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getAllByText('today 14:12')[1]!);
    expect(onView).toHaveBeenLastCalledWith(undefined);
  });

  it('says it is reading rather than watching, when it is', () => {
    render(createElement(RunPicker, { runs: [CURRENT, OLDER], viewing: OLDER.id }));
    expect(screen.getByText('reading')).toBeInTheDocument();
  });
});
