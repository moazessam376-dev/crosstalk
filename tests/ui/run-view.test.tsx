// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { RunPicker } from '../../src/ui/layout/RunPicker.js';
import type { RunSummary } from '../../src/core/runs.js';

/**
 * Opening an older run from the picker.
 *
 * The picker listed them and clicking one did nothing — `onView` existed as a
 * prop and was never passed, and no route stood behind it. An inert menu row is
 * the "control that cannot work" failure this project exists to catch, and it
 * was especially wrong here: the operator's complaint was that they could not
 * get *away* from the last session, and the fix as shipped left them unable to
 * get *back* to it.
 */

afterEach(cleanup);

function textOf(element: Element): string {
  return (element as unknown as { textContent: string }).textContent;
}

/**
 * A row in the open menu, not the button that opened it.
 *
 * The button shows the same label as the row for the run it is showing, so an
 * unscoped `getByText` finds two and fails — in a way that reads like the row
 * is missing rather than like the query is ambiguous.
 */
function closest(element: Element, selector: string): Element | null {
  return (element as unknown as { closest(s: string): Element | null }).closest(selector);
}

function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: '.run-when' });
}

/**
 * Built from local `Date`s and relative to *now*, not from literals.
 *
 * `runLabel` stamps local time deliberately — the operator reads these beside
 * "today 14:12" and a run that says 21:12 when they started it at 14:12 is one
 * they cannot find. A fixture written as a UTC ISO string therefore renders
 * differently in every zone, and a hardcoded date stops being "today" tomorrow.
 * Both mistakes were made here before this comment existed.
 */
const NOW = new Date();
const at = (daysAgo: number, hour: number, minute: number): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour, minute).toISOString();

const TODAY = `today ${String(14).padStart(2, '0')}:12`;
const YESTERDAY = 'yesterday 09:04';

const RUNS: RunSummary[] = [
  { id: 'r-20260902-1412-a3f1c9', startedAt: at(0, 14, 12), firstSeq: 40, events: 12, archived: false, current: true },
  { id: 'r-20260901-0904-b2e0d1', startedAt: at(1, 9, 4), firstSeq: 1, events: 31, archived: false, current: false },
];

describe('the run picker as navigation', () => {
  it('opens an older run by its id, and the current one by nothing', () => {
    // `undefined` for the current run rather than its id: the live board is
    // the buffer the stream is filling, not a fetched snapshot of it, and the
    // two have to stay distinguishable at the call site.
    const onView = vi.fn();
    render(createElement(RunPicker, { runs: RUNS, onView }));

    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    fireEvent.click(row(YESTERDAY));
    expect(onView).toHaveBeenCalledWith('r-20260901-0904-b2e0d1');

    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    fireEvent.click(row(TODAY));
    expect(onView).toHaveBeenLastCalledWith(undefined);
  });

  it('says on its face that it is showing a run you cannot write to', () => {
    // The composer disappearing is the mechanism; this is the label. Without
    // it a read-only board is indistinguishable from a live one where nobody
    // has said anything yet — which is this project's signature failure.
    render(createElement(RunPicker, { runs: RUNS, viewing: 'r-20260901-0904-b2e0d1' }));

    const button = screen.getByRole('button', { name: /Run/ });
    expect(textOf(button)).toContain(YESTERDAY);
    expect(textOf(button)).toContain('reading');
  });

  it('says nothing extra while the current run is the one shown', () => {
    render(createElement(RunPicker, { runs: RUNS }));
    expect(textOf(screen.getByRole('button', { name: /Run/ }))).not.toContain('reading');
  });

  it('marks which row is open, so the menu is not a list of identical rows', async () => {
    render(createElement(RunPicker, { runs: RUNS, viewing: 'r-20260901-0904-b2e0d1' }));
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));

    await waitFor(() => expect(row(YESTERDAY)).toBeInTheDocument());
    const open = closest(row(YESTERDAY), 'button')!;
    expect(open).toHaveAttribute('aria-current', 'true');
    expect(closest(row(TODAY), 'button')).not.toHaveAttribute('aria-current');
  });
});
