import { createElement, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ScreenModes } from '../../harness/screen.js';
import type { MirrorRun, MirrorScreen } from '../state/useSessionMirror.js';
import { clickBytes, focusBytes, keyBytes, pasteBytes, wheelBytes, type KeyStroke } from './keys.js';

/**
 * The 256-colour palette, as CSS.
 *
 * This used to fold every colour onto the sixteen the theme defines, on the
 * argument that the mirror should wear the hub's palette rather than the
 * operator's terminal profile. The argument was fine and the result was not:
 * measured against a real Claude Code screen, five distinct colours became
 * three, and indices 114, 153 and 174 — a green, a blue and a pink — all landed
 * on the same bright white. A menu that marks its selection with colour has no
 * selection left after that.
 *
 * So the first sixteen still come from the theme, which is what keeps the
 * mirror looking like the rest of the hub, and the other 240 are the standard
 * cube and grey ramp, computed rather than folded. Nothing above 15 was ever
 * theme-able anyway: xterm's cube is a fixed table, not a profile.
 */
function paletteColour(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined;
  if (index < 16) return `var(--term-${index})`;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level} ${level} ${level})`;
  }
  const cube = index - 16;
  const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${step(Math.floor(cube / 36))} ${step(Math.floor((cube % 36) / 6))} ${step(cube % 6)})`;
}

/**
 * Fold any of xterm's 256 indices onto the sixteen the theme defines.
 *
 * Kept because it is still the right answer for one job — naming a colour for a
 * test or a screen reader, where 240 shades are noise — and because removing a
 * pure function that six tests pin is a separate change from fixing what the
 * screen looks like.
 *
 * 16–231 is a 6×6×6 cube: read the levels back out, take the dominant
 * channels, and brighten when any of them is near the top. 232–255 is the grey
 * ramp, which folds to black / bright-black / white / bright-white by
 * luminance.
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
  if (run.bold === true) classes.push('is-bold');
  if (run.dim === true) classes.push('is-dim');
  if (run.inverse === true) classes.push('is-inverse');
  return classes.join(' ');
}

/**
 * A run's colours, inverse resolved here rather than in CSS.
 *
 * It has to be here now that colours are inline: a stylesheet rule for
 * `.is-inverse` cannot beat an inline `color`, so a reversed run with a colour
 * of its own would have kept its colour and lost its reversal — which is how a
 * selected menu row stops looking selected.
 */
function styleFor(run: MirrorRun): Record<string, string> {
  const fg = run.fg === undefined ? undefined : paletteColour(run.fg);
  const bg = run.bg === undefined ? undefined : paletteColour(run.bg);
  const style: Record<string, string> = {};
  if (run.inverse === true) {
    style.color = bg ?? 'var(--surface-base)';
    style.background = fg ?? 'var(--text-primary)';
    return style;
  }
  if (fg !== undefined) style.color = fg;
  if (bg !== undefined) style.background = bg;
  return style;
}

/**
 * The bits of an element this actually uses.
 *
 * Structural rather than `HTMLDivElement`, matching `Stream`: the frozen test
 * config omits the DOM lib, so naming the browser's types here would make the
 * module uncompilable rather than making it safer.
 */
interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface Measurable {
  getBoundingClientRect(): Box;
}

/** Only what is used, for the same reason as `Box`: no DOM lib in this config. */
interface Observer {
  observe(target: TerminalRoot): void;
  disconnect(): void;
}
declare const ResizeObserver: (new (callback: () => void) => Observer) | undefined;

interface TerminalRoot {
  readonly clientWidth: number;
  readonly clientHeight: number;
  querySelector(selector: string): Measurable | null;
  querySelectorAll(selector: string): ArrayLike<Measurable>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface TerminalProps {
  screen: MirrorScreen;
  /** Drawn only while the seat is alive: a dead terminal has no cursor. */
  live?: boolean;
  /**
   * Where a keystroke goes. Absent, the screen is a picture of a terminal
   * rather than a terminal — which is what it was until an operator watched
   * three seats stop on a dialog they could see and could not answer.
   */
  onKey?: (bytes: string) => void;
  /**
   * Told how many cells the panel is actually drawing.
   *
   * Measured off the rendered grid rather than computed: the panel already
   * draws one, and measuring it is the only way to be right about zoom, a user
   * stylesheet, or a font that has not finished loading.
   */
  onGeometry?: (rows: number, cols: number) => void;
}

/** Lines held above the top row, drawn above it. */
export interface TerminalHistory {
  rows: MirrorRun[][];
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
export function Terminal({ screen, live = true, onKey, onGeometry }: TerminalProps) {
  const takesKeys = onKey !== undefined;
  const root = useRef<TerminalRoot | null>(null);
  const modes: ScreenModes | undefined = screen.modes;

  /**
   * Which cell an event landed on.
   *
   * From the row element under the pointer, not from a font metric: the rows
   * are in the DOM and their boxes are exact, so this is right through a zoom
   * that a character-width calculation would get wrong.
   */
  const cellAt = useCallback((clientX: number, clientY: number): { col: number; row: number } => {
    const element = root.current;
    if (element === null) return { col: 1, row: 1 };
    const rows = element.querySelectorAll('.terminal-row');
    const first = rows[0];
    if (first === undefined) return { col: 1, row: 1 };
    const box = first.getBoundingClientRect();
    const height = box.height || 1;
    const width = box.width / Math.max(1, screen.cols) || 1;
    const row = Math.max(1, Math.min(rows.length, Math.floor((clientY - box.top) / height) + 1));
    const col = Math.max(1, Math.min(screen.cols, Math.floor((clientX - box.left) / width) + 1));
    return { col, row };
  }, [screen.cols]);

  // Report geometry once drawn, and again whenever the box changes. A seat that
  // is never told its size renders into a 110-column terminal inside a window
  // twice that wide, which is the "very limited" half of the complaint.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null || onGeometry === undefined) return;

    const measure = (): void => {
      const probe = element.querySelector('.terminal-row');
      if (probe === null) return;
      const box = probe.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0) return;
      const cell = box.width / Math.max(1, screen.cols);
      if (cell <= 0) return;
      const cols = Math.max(20, Math.floor(element.clientWidth / cell));
      const rows = Math.max(4, Math.floor(element.clientHeight / box.height));
      onGeometry(rows, cols);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onGeometry, screen.cols]);

  // Focus reporting. An application that asked to know is told, and one that
  // did not is not — `focusBytes` decides, so this never invents traffic.
  useEffect(() => {
    const element = root.current;
    if (element === null || onKey === undefined) return;
    const enter = (): void => {
      const bytes = focusBytes(true, modes);
      if (bytes !== undefined) onKey(bytes);
    };
    const leave = (): void => {
      const bytes = focusBytes(false, modes);
      if (bytes !== undefined) onKey(bytes);
    };
    element.addEventListener('focus', enter);
    element.addEventListener('blur', leave);
    return () => {
      element.removeEventListener('focus', enter);
      element.removeEventListener('blur', leave);
    };
  }, [onKey, modes]);

  return createElement(
    'div',
    {
      className: 'terminal',
      'data-testid': 'terminal',
      ref: root,
      ...(screen.alt === true ? { 'data-alt': 'true' } : {}),
      // Focusable, so it can take the keyboard the way a terminal does. A
      // `log` is something you read; this is something you type into.
      ...(takesKeys
        ? {
            tabIndex: 0,
            role: 'application',
            'aria-label': 'agent terminal — click to type into this seat',
            onKeyDown: (event: KeyStroke & { preventDefault(): void; stopPropagation(): void }) => {
              const bytes = keyBytes(event, modes);
              if (bytes === undefined) return;
              // Only once we are actually sending it. Letting the browser keep
              // the ones we do not handle is what leaves Cmd-R and Cmd-C alone,
              // and stops the page scrolling under an arrow key we did send.
              event.preventDefault();
              event.stopPropagation();
              onKey(bytes);
            },
            // Cmd-V reached a non-editable `div` and did nothing, so pasting
            // into a mirrored terminal was impossible. The keyboard path cannot
            // help — `keyBytes` deliberately never translates Meta — so the
            // paste event itself is the only door.
            onPaste: (event: {
              clipboardData: { getData(type: string): string } | null;
              preventDefault(): void;
            }) => {
              const text = event.clipboardData?.getData('text') ?? '';
              if (text === '') return;
              event.preventDefault();
              onKey(pasteBytes(text, modes));
            },
            onWheel: (event: {
              deltaY: number;
              clientX: number;
              clientY: number;
              shiftKey: boolean;
              preventDefault(): void;
            }) => {
              // Both agent CLIs run on the alternate screen: they own their own
              // transcript, and the wheel is how a real terminal asks them to
              // scroll it. Sending nothing is why there was no way up.
              const at = cellAt(event.clientX, event.clientY);
              const bytes = wheelBytes(
                { deltaY: event.deltaY, col: at.col, row: at.row, shiftKey: event.shiftKey },
                modes,
              );
              if (bytes === undefined) return;
              event.preventDefault();
              onKey(bytes);
            },
            onMouseDown: (event: {
              button: number;
              clientX: number;
              clientY: number;
              shiftKey: boolean;
              altKey: boolean;
              ctrlKey: boolean;
              detail: number;
            }) => {
              const at = cellAt(event.clientX, event.clientY);
              const bytes = clickBytes(
                {
                  button: event.button,
                  col: at.col,
                  row: at.row,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                },
                modes,
              );
              // Not prevented: the click still has to focus the panel and still
              // has to be allowed to start a text selection, which is how the
              // operator copies what they are reading.
              if (bytes !== undefined) onKey(bytes);
            },
          }
        : { role: 'log', 'aria-label': 'agent terminal' }),
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
            ' '
          : runs.map((run, index) =>
              createElement(
                'span',
                { key: index, className: classesFor(run), style: styleFor(run) },
                run.text,
              ),
            ),
        live && screen.cursor.row === row && screen.modes?.cursorVisible !== false
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
