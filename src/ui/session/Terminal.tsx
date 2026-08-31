import { createElement } from 'react';
import type { MirrorRun, MirrorScreen } from '../state/useSessionMirror.js';

/**
 * Fold any of xterm's 256 indices onto the sixteen the theme defines.
 *
 * The hub is not trying to reproduce the operator's terminal profile — it has
 * its own palette, and a mirror that ignored it would be the one panel on the
 * screen wearing somebody else's colours. Sixteen tokens in `theme.css` is
 * also the whole palette surface, so there is no way for a colour to be
 * defined anywhere else.
 *
 * 16–231 is a 6×6×6 cube: read the levels back out, take the dominant
 * channels, and brighten when any of them is near the top. 232–255 is the grey
 * ramp, which folds to black / bright-black / white / bright-white by
 * luminance — greys are how a TUI draws its chrome, so getting the four steps
 * right matters more here than anywhere else in the fold.
 */
export function ansi16(index: number): number {
  if (index < 16) return index;
  if (index >= 232) {
    const level = index - 232; // 0..23
    if (level < 6) return 0;
    if (level < 14) return 8;
    if (level < 20) return 7;
    return 15;
  }
  const cube = index - 16;
  const red = Math.floor(cube / 36);
  const green = Math.floor((cube % 36) / 6);
  const blue = cube % 6;
  const peak = Math.max(red, green, blue);
  if (peak === 0) return 0;
  // A channel counts as "on" once it is at least half the brightest one, which
  // is what keeps a colour like (5,3,0) reading as yellow rather than red.
  const on = (value: number): number => (value * 2 >= peak ? 1 : 0);
  const base = on(red) * 1 + on(green) * 2 + on(blue) * 4;
  return peak >= 4 ? base + 8 : base;
}

function classesFor(run: MirrorRun): string {
  const classes = ['term-run'];
  if (run.fg !== undefined) classes.push(`term-fg-${ansi16(run.fg)}`);
  if (run.bg !== undefined) classes.push(`term-bg-${ansi16(run.bg)}`);
  if (run.bold === true) classes.push('is-bold');
  if (run.dim === true) classes.push('is-dim');
  if (run.inverse === true) classes.push('is-inverse');
  return classes.join(' ');
}

export interface TerminalProps {
  screen: MirrorScreen;
  /** Drawn only while the seat is alive: a dead terminal has no cursor. */
  live?: boolean;
}

/**
 * A reconstructed screen, drawn.
 *
 * One `<div>` per row and one `<span>` per attribute run — not per character.
 * A TUI row is usually one to five runs, so a 32-row screen is a hundred-odd
 * nodes; per-character spans would be three thousand, re-created on every
 * frame, which is the difference between a mirror that idles at nothing and
 * one that makes the tab hot.
 *
 * Rows are keyed by index rather than content. That is the correct key here
 * and unusual enough to be worth saying why: a terminal row *is* its position.
 * Row 4 stays row 4 when its text changes, and keying by text would make React
 * tear down and rebuild the row on every repaint.
 */
export function Terminal({ screen, live = true }: TerminalProps) {
  return createElement(
    'div',
    {
      className: 'terminal',
      'data-testid': 'terminal',
      role: 'log',
      'aria-label': 'agent terminal',
      // The grid is fixed-width by construction, so the panel scales the whole
      // screen rather than reflowing it — a mirror that rewrapped would stop
      // being a mirror.
      style: { '--term-cols': String(screen.cols) } as Record<string, string>,
    },
    screen.rows.map((runs, row) =>
      createElement(
        'div',
        { key: row, className: 'terminal-row' },
        runs.length === 0
          ? // A zero-height row collapses the grid and makes the screen jump as
            // lines empty and fill. The space holds it open.
            ' '
          : runs.map((run, index) =>
              createElement('span', { key: index, className: classesFor(run) }, run.text),
            ),
        live && screen.cursor.row === row
          ? createElement('span', {
              className: 'terminal-cursor',
              'data-testid': 'terminal-cursor',
              'aria-hidden': 'true',
              style: { '--term-cursor-col': String(screen.cursor.col) } as Record<string, string>,
            })
          : null,
      ),
    ),
  );
}
