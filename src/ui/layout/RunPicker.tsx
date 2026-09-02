import { createElement, useState } from 'react';

import type { RunSummary } from '../../core/runs.js';

export interface RunPickerProps {
  runs: RunSummary[];
  /** Which run the board is showing. Absent means the current one. */
  viewing?: string;
  onView?: (runId: string | undefined) => void;
  onArchive?: (runId: string) => void;
  onDelete?: (runId: string) => void;
  onStartNew?: () => void;
}

/**
 * The run the board is showing, and a way to reach the others.
 *
 * Lives in the sidebar head, above the rooms, because it is navigation: which
 * conversation you are in, not what is in it. The operator's complaint was
 * "every time I access crosstalk I get the last session's stuff" — the boundary
 * fixes what is shown, and this is where they say so themselves: put that one
 * away, start a fresh one, go back and read an old one.
 */

/** `today 14:12`, `yesterday 09:04`, `2 Sep 14:12`. Read at a glance, not parsed. */
export function runLabel(run: RunSummary, now: Date): string {
  const at = new Date(run.startedAt);
  if (Number.isNaN(at.getTime())) return run.id;
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((midnight - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${at.getDate()} ${at.toLocaleString('en', { month: 'short' })} ${time}`;
}

function summaryLine(run: RunSummary): string {
  const events = `${run.events} event${run.events === 1 ? '' : 's'}`;
  return run.archived ? `${events} · archived` : events;
}

export function RunPicker({
  runs,
  viewing,
  onView,
  onArchive,
  onDelete,
  onStartNew,
}: RunPickerProps) {
  const [open, setOpen] = useState(false);
  /**
   * Where to put the menu, measured when it is opened.
   *
   * `.hub-sidebar` is `overflow: hidden` on purpose — the hub clamps to the
   * viewport so the log is the only thing that scrolls — which clips any
   * absolutely-positioned child. Measured looking: the menu rendered, and half
   * of it was behind the sidebar's edge. `fixed` escapes the clip, and a
   * `fixed` box needs real coordinates, so they are read off the button at the
   * moment of the click. It closes on any choice, so a stale anchor after a
   * resize is not a state the operator can sit in.
   */
  const [anchor, setAnchor] = useState<{ top: number; left: number } | undefined>();
  // Typed to confirm, not clicked to confirm. Deleting an archive is the only
  // irreversible act in the hub, so it asks for the thing itself.
  const [confirming, setConfirming] = useState<string | undefined>();
  const [typed, setTyped] = useState('');

  const now = new Date();
  const current = runs.find((run) => run.current);
  const shown = viewing === undefined ? current : runs.find((run) => run.id === viewing);

  const rows = runs.map((run) => {
    const isViewing = run.id === shown?.id;
    if (confirming === run.id) {
      return createElement(
        'li',
        { key: run.id, className: 'run-row is-confirming' },
        createElement('p', { className: 'run-confirm-ask' }, `Delete ${runLabel(run, now)} permanently? Type its id.`),
        createElement('code', { className: 'run-confirm-id' }, run.id),
        createElement('input', {
          className: 'run-confirm-input',
          'aria-label': 'run id to confirm',
          value: typed,
          onChange: (event: { target: { value: string } }) => setTyped(event.target.value),
        }),
        createElement(
          'div',
          { className: 'run-confirm-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'run-action is-danger',
              disabled: typed !== run.id,
              onClick: () => {
                onDelete?.(run.id);
                setConfirming(undefined);
                setTyped('');
              },
            },
            'Delete',
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'run-action',
              onClick: () => {
                setConfirming(undefined);
                setTyped('');
              },
            },
            'Cancel',
          ),
        ),
      );
    }

    return createElement(
      'li',
      { key: run.id, className: `run-row${isViewing ? ' is-viewing' : ''}` },
      createElement(
        'button',
        {
          type: 'button',
          className: 'run-open',
          'aria-current': isViewing ? 'true' : undefined,
          onClick: () => {
            onView?.(run.current ? undefined : run.id);
            setOpen(false);
          },
        },
        createElement('span', { className: 'run-when' }, runLabel(run, now)),
        createElement('span', { className: 'run-facts' }, summaryLine(run)),
        run.current ? createElement('span', { className: 'run-live' }, 'live') : null,
      ),
      // The current run cannot be archived: it is the one being written to.
      run.current || run.archived
        ? null
        : createElement(
            'button',
            { type: 'button', className: 'run-action', onClick: () => onArchive?.(run.id) },
            'Archive',
          ),
      run.archived
        ? createElement(
            'button',
            {
              type: 'button',
              className: 'run-action is-danger',
              onClick: () => {
                setConfirming(run.id);
                setTyped('');
              },
            },
            'Delete',
          )
        : null,
    );
  });

  return createElement(
    'div',
    { className: 'run-picker', 'data-testid': 'run-picker' },
    createElement(
      'button',
      {
        type: 'button',
        className: 'run-current',
        'aria-expanded': open ? 'true' : 'false',
        onClick: (event: { currentTarget: { getBoundingClientRect(): { bottom: number; left: number } } }) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAnchor({ top: box.bottom + 4, left: box.left });
          setOpen(!open);
        },
      },
      createElement('span', { className: 'run-current-label' }, 'Run'),
      createElement(
        'span',
        { className: 'run-current-when' },
        shown === undefined ? 'none yet' : runLabel(shown, now),
      ),
      shown !== undefined && !shown.current
        ? createElement('span', { className: 'run-current-tag' }, 'reading')
        : null,
    ),
    open
      ? createElement(
          'div',
          { className: 'run-menu', style: anchor === undefined ? undefined : anchor },
          createElement('ul', { className: 'run-list' }, rows),
          createElement(
            'button',
            {
              type: 'button',
              className: 'run-new',
              onClick: () => {
                onStartNew?.();
                setOpen(false);
              },
            },
            'Start a new run',
          ),
        )
      : null,
  );
}
