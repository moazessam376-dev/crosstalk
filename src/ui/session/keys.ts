/**
 * What a real keyboard sends, from what the browser reports.
 *
 * The mirror draws a terminal, so it has to take a terminal's input: arrows
 * move a selection, Return confirms, Escape cancels, Ctrl-C interrupts. Four
 * buttons under the screen are a workaround for not having this, and they are
 * only any use for the four things somebody thought of in advance — the first
 * seat to stop on a dialog with a text field, a pager, or a three-way choice
 * would have been unanswerable again.
 *
 * The encodings are xterm's, matching the `TERM` the seat is spawned with, so
 * what the harness receives is indistinguishable from someone at the keyboard.
 *
 * **A terminal's encoding depends on what the application asked for.** That is
 * the part this used to miss. An application says what it wants with the same
 * escape sequences it uses to draw — application cursor keys, bracketed paste,
 * mouse reporting, focus events — and `Screen` now keeps them, so every
 * function here takes the modes rather than assuming a bare VT100 is listening.
 * Sending `ESC [ A` to an application that asked for `ESC O A` is a key that
 * does nothing, which is exactly what a menu that will not move looks like.
 */

import type { ScreenModes } from '../../harness/screen.js';

const ESC = '\u001b';
const DEL = '\u007f';
const NUL = '\u0000';

/** Just the modifier itself: nothing to send until it is combined with a key. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

/**
 * Keys whose encoding changes with DECCKM.
 *
 * The cursor keys and Home/End only. Everything else in the keypad keeps its
 * `ESC [ … ~` form in both modes, which is why the table below is split rather
 * than doubled.
 */
const CURSOR: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
};

const NAMED: Record<string, string> = {
  Enter: '\r',
  Backspace: DEL,
  Tab: '\t',
  Escape: ESC,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Delete: `${ESC}[3~`,
  Insert: `${ESC}[2~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
};

/** The shape this needs off a KeyboardEvent, so it can be tested without one. */
export interface KeyStroke {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * xterm's modifier parameter: 1 + a bit per held modifier.
 *
 * Shift-Tab is the one everybody knows (`ESC [ Z`); the rest of the family is
 * how an application hears Ctrl-ArrowLeft as "move a word" rather than as a
 * bare arrow with the Ctrl silently dropped.
 */
function modifierParam(stroke: KeyStroke): number {
  return 1 + (stroke.shiftKey === true ? 1 : 0) + (stroke.altKey === true ? 2 : 0) + (stroke.ctrlKey === true ? 4 : 0);
}

/**
 * The bytes for one keystroke, or `undefined` when the browser should keep it.
 *
 * Meta is deliberately never translated: Cmd-R, Cmd-L, Cmd-Tab and Cmd-C belong
 * to the browser, and a mirror that ate them would trap the operator inside a
 * panel with no way to reload the page or copy what they are reading.
 */
export function keyBytes(stroke: KeyStroke, modes?: ScreenModes): string | undefined {
  if (stroke.metaKey === true) return undefined;
  if (MODIFIERS.has(stroke.key)) return undefined;

  if (stroke.key === 'Tab' && stroke.shiftKey === true) return `${ESC}[Z`;

  const cursor = CURSOR[stroke.key];
  if (cursor !== undefined) {
    const modifier = modifierParam(stroke);
    // A modified cursor key is always the CSI form with a parameter, in both
    // modes — `ESC O 1 ; 5 A` is not a thing any application reads.
    if (modifier !== 1) return `${ESC}[1;${modifier}${cursor}`;
    return modes?.applicationCursor === true ? `${ESC}O${cursor}` : `${ESC}[${cursor}`;
  }

  const named = NAMED[stroke.key];
  if (named !== undefined) return named;

  // Not a single character: a dead key, something this does not model. Sending
  // its name as text would type "AudioVolumeUp" into the composer.
  if ([...stroke.key].length !== 1) return undefined;

  if (stroke.ctrlKey === true) {
    // Ctrl-A..Ctrl-Z and the handful around them are the low control codes:
    // mask off the top bits, exactly as a terminal driver does.
    const code = stroke.key.toUpperCase().codePointAt(0)!;
    if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
    if (stroke.key === ' ') return NUL;
    return undefined;
  }

  // Alt-x is Escape then x, which is how a terminal has always spelled Meta.
  if (stroke.altKey === true) return ESC + stroke.key;

  return stroke.key;
}

/**
 * Pasted text, as the application asked to receive it.
 *
 * Under bracketed paste the text is fenced, so an editor knows it is a paste
 * and does not run its per-keystroke handlers over it — which is the difference
 * between pasting ten lines and having the first newline submit the prompt.
 * Both agent CLIs turn it on.
 *
 * The fence markers are stripped from the payload rather than escaped, because
 * there is no escape for them: text containing the end marker would close the
 * paste early and the tail would be read as typing.
 */
export function pasteBytes(text: string, modes?: ScreenModes): string {
  const safe = text.split(`${ESC}[200~`).join('').split(`${ESC}[201~`).join('');
  if (modes?.bracketedPaste !== true) return safe;
  return `${ESC}[200~${safe}${ESC}[201~`;
}

/** Told to an application that asked to know, and to nobody else. */
export function focusBytes(focused: boolean, modes?: ScreenModes): string | undefined {
  if (modes?.focusReporting !== true) return undefined;
  return focused ? `${ESC}[I` : `${ESC}[O`;
}

export interface WheelEvent {
  /** Negative scrolls the content up — the browser's sign convention. */
  deltaY: number;
  /** One-based cell coordinates, as a terminal counts them. */
  col: number;
  row: number;
  shiftKey?: boolean;
}

/**
 * A wheel turn, as a mouse button press.
 *
 * This is the answer to "I cannot scroll up" for both agent CLIs, and it is not
 * the same answer as scrollback. They run on the alternate screen: they own the
 * whole terminal and their own history, so there is nothing above the top row
 * to scroll to — in the hub or in a real terminal. What a real terminal does is
 * forward the wheel, and the application scrolls its own transcript. The mirror
 * sent no mouse events at all, so the wheel did nothing and the transcript was
 * unreachable.
 *
 * Buttons 64 and 65 are wheel-up and wheel-down. SGR encoding (`?1006`) is
 * preferred because the legacy form cannot address a column past 223, and a
 * mirror at 110 columns is one window-drag away from that.
 */
export function wheelBytes(event: WheelEvent, modes?: ScreenModes): string | undefined {
  if (modes?.mouse !== true) return undefined;
  if (event.deltaY === 0) return undefined;
  const button = (event.deltaY < 0 ? 64 : 65) + (event.shiftKey === true ? 4 : 0);
  const col = Math.max(1, Math.trunc(event.col));
  const row = Math.max(1, Math.trunc(event.row));
  if (modes.sgrMouse === true) return `${ESC}[<${button};${col};${row}M`;
  // Legacy X10: a byte per field, offset by 32. Unaddressable past 223.
  if (col > 223 || row > 223) return undefined;
  return `${ESC}[M${String.fromCharCode(32 + button, 32 + col, 32 + row)}`;
}

export interface ClickEvent {
  /** 0 left, 1 middle, 2 right — the browser's numbering. */
  button: number;
  col: number;
  row: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * A click, as press and release.
 *
 * Sent as a pair because an application that only ever hears presses will hold
 * a selection open forever. Under `?1006` the release is a distinct `m`
 * terminator; the legacy form spells it as button 3.
 */
export function clickBytes(event: ClickEvent, modes?: ScreenModes): string | undefined {
  if (modes?.mouse !== true) return undefined;
  const base = Math.max(0, Math.min(2, Math.trunc(event.button)));
  const modifiers =
    (event.shiftKey === true ? 4 : 0) + (event.altKey === true ? 8 : 0) + (event.ctrlKey === true ? 16 : 0);
  const col = Math.max(1, Math.trunc(event.col));
  const row = Math.max(1, Math.trunc(event.row));
  if (modes.sgrMouse === true) {
    return `${ESC}[<${base + modifiers};${col};${row}M${ESC}[<${base + modifiers};${col};${row}m`;
  }
  if (col > 223 || row > 223) return undefined;
  const press = `${ESC}[M${String.fromCharCode(32 + base + modifiers, 32 + col, 32 + row)}`;
  const release = `${ESC}[M${String.fromCharCode(32 + 3 + modifiers, 32 + col, 32 + row)}`;
  return press + release;
}
