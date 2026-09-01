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
 */

const ESC = '\u001b';
const DEL = '\u007f';
const NUL = '\u0000';

/** Just the modifier itself: nothing to send until it is combined with a key. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

const NAMED: Record<string, string> = {
  Enter: '\r',
  Backspace: DEL,
  Tab: '\t',
  Escape: ESC,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Delete: `${ESC}[3~`,
  Insert: `${ESC}[2~`,
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
 * The bytes for one keystroke, or `undefined` when the browser should keep it.
 *
 * Meta is deliberately never translated: Cmd-R, Cmd-L, Cmd-Tab and Cmd-C belong
 * to the browser, and a mirror that ate them would trap the operator inside a
 * panel with no way to reload the page or copy what they are reading.
 */
export function keyBytes(stroke: KeyStroke): string | undefined {
  if (stroke.metaKey === true) return undefined;
  if (MODIFIERS.has(stroke.key)) return undefined;

  if (stroke.key === 'Tab' && stroke.shiftKey === true) return `${ESC}[Z`;

  const named = NAMED[stroke.key];
  if (named !== undefined) return named;

  // Not a single character: a function key, a dead key, something this does not
  // model. Sending its name as text would type "F5" into the composer.
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
