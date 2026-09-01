import { describe, expect, it } from 'vitest';

import type { ScreenModes } from '../../src/harness/screen.js';
import { clickBytes, focusBytes, keyBytes, pasteBytes, wheelBytes } from '../../src/ui/session/keys.js';

const ESC = '\u001b';

function modes(overrides: Partial<ScreenModes> = {}): ScreenModes {
  return {
    applicationCursor: false,
    focusReporting: false,
    bracketedPaste: false,
    mouse: false,
    sgrMouse: false,
    alt: false,
    cursorVisible: true,
    ...overrides,
  };
}

/** What a real `claude --remote-control` session asks for, captured off its pty. */
const CLAUDE = modes({
  applicationCursor: true,
  focusReporting: true,
  bracketedPaste: true,
  mouse: true,
  sgrMouse: true,
  alt: true,
});

describe('cursor keys follow DECCKM', () => {
  it('sends the CSI form to a plain terminal', () => {
    expect(keyBytes({ key: 'ArrowUp' }, modes())).toBe(`${ESC}[A`);
    expect(keyBytes({ key: 'ArrowDown' }, modes())).toBe(`${ESC}[B`);
  });

  it('sends the SS3 form once the application asks for it', () => {
    // The measured defect: an arrow key that moved no selection. An application
    // in application-cursor mode does not read `ESC [ A` as an arrow at all.
    expect(keyBytes({ key: 'ArrowUp' }, CLAUDE)).toBe(`${ESC}OA`);
    expect(keyBytes({ key: 'ArrowDown' }, CLAUDE)).toBe(`${ESC}OB`);
    expect(keyBytes({ key: 'Home' }, CLAUDE)).toBe(`${ESC}OH`);
  });

  it('keeps the CSI form for a modified arrow, in either mode', () => {
    expect(keyBytes({ key: 'ArrowLeft', ctrlKey: true }, CLAUDE)).toBe(`${ESC}[1;5D`);
    expect(keyBytes({ key: 'ArrowLeft', ctrlKey: true }, modes())).toBe(`${ESC}[1;5D`);
    expect(keyBytes({ key: 'ArrowRight', shiftKey: true }, modes())).toBe(`${ESC}[1;2C`);
  });

  it('still works with no modes at all, for a screen that never said', () => {
    expect(keyBytes({ key: 'ArrowUp' })).toBe(`${ESC}[A`);
  });
});

describe('the rest of the keyboard', () => {
  it('sends what a terminal sends', () => {
    expect(keyBytes({ key: 'Enter' })).toBe('\r');
    expect(keyBytes({ key: 'Backspace' })).toBe('\u007f');
    expect(keyBytes({ key: 'Escape' })).toBe(ESC);
    expect(keyBytes({ key: 'Tab' })).toBe('\t');
    expect(keyBytes({ key: 'Tab', shiftKey: true })).toBe(`${ESC}[Z`);
    expect(keyBytes({ key: 'c', ctrlKey: true })).toBe('\u0003');
    expect(keyBytes({ key: 'a' })).toBe('a');
  });

  it('sends the function keys, which used to type their own names', () => {
    expect(keyBytes({ key: 'F1' })).toBe(`${ESC}OP`);
    expect(keyBytes({ key: 'F5' })).toBe(`${ESC}[15~`);
    expect(keyBytes({ key: 'F12' })).toBe(`${ESC}[24~`);
  });

  it('leaves the browser its own shortcuts', () => {
    expect(keyBytes({ key: 'r', metaKey: true })).toBeUndefined();
    expect(keyBytes({ key: 'Shift' })).toBeUndefined();
    expect(keyBytes({ key: 'AudioVolumeUp' })).toBeUndefined();
  });
});

describe('paste', () => {
  it('is plain text to an application that did not ask for brackets', () => {
    expect(pasteBytes('hello world', modes())).toBe('hello world');
  });

  it('is fenced for an application that did', () => {
    expect(pasteBytes('hello', CLAUDE)).toBe(`${ESC}[200~hello${ESC}[201~`);
  });

  it('keeps a multi-line paste in one piece', () => {
    // The point of bracketing: without it the first newline submits the prompt
    // and the rest of the paste is typed into whatever came next.
    expect(pasteBytes('one\ntwo\nthree', CLAUDE)).toBe(`${ESC}[200~one\ntwo\nthree${ESC}[201~`);
  });

  it('cannot be made to close its own fence early', () => {
    const hostile = `evil${ESC}[201~rm -rf /`;
    const sent = pasteBytes(hostile, CLAUDE);
    expect(sent).toBe(`${ESC}[200~evilrm -rf /${ESC}[201~`);
    expect(sent.split(`${ESC}[201~`)).toHaveLength(2);
  });
});

describe('focus', () => {
  it('says nothing to an application that did not ask', () => {
    expect(focusBytes(true, modes())).toBeUndefined();
    expect(focusBytes(false, modes())).toBeUndefined();
  });

  it('reports both directions to one that did', () => {
    expect(focusBytes(true, CLAUDE)).toBe(`${ESC}[I`);
    expect(focusBytes(false, CLAUDE)).toBe(`${ESC}[O`);
  });
});

describe('the wheel', () => {
  it('is not sent to an application that does not track the mouse', () => {
    expect(wheelBytes({ deltaY: -100, col: 5, row: 5 }, modes())).toBeUndefined();
  });

  it('is how an alt-screen agent CLI scrolls its own transcript', () => {
    // Neither CLI has scrollback for the hub to show: they own the screen. The
    // wheel is the whole mechanism, and none of it was being sent.
    expect(wheelBytes({ deltaY: -100, col: 5, row: 9 }, CLAUDE)).toBe(`${ESC}[<64;5;9M`);
    expect(wheelBytes({ deltaY: 100, col: 5, row: 9 }, CLAUDE)).toBe(`${ESC}[<65;5;9M`);
  });

  it('says nothing about a wheel that did not turn', () => {
    expect(wheelBytes({ deltaY: 0, col: 5, row: 5 }, CLAUDE)).toBeUndefined();
  });

  it('falls back to the legacy encoding when SGR was not asked for', () => {
    const legacy = modes({ mouse: true });
    expect(wheelBytes({ deltaY: -1, col: 1, row: 1 }, legacy)).toBe(`${ESC}[M${String.fromCharCode(96, 33, 33)}`);
  });

  it('declines a legacy report it cannot address rather than sending a wrong one', () => {
    const legacy = modes({ mouse: true });
    expect(wheelBytes({ deltaY: -1, col: 400, row: 1 }, legacy)).toBeUndefined();
    // The same coordinate is fine under SGR, which is why SGR is preferred.
    expect(wheelBytes({ deltaY: -1, col: 400, row: 1 }, CLAUDE)).toBe(`${ESC}[<64;400;1M`);
  });
});

describe('clicks', () => {
  it('are not sent to an application that does not track the mouse', () => {
    expect(clickBytes({ button: 0, col: 3, row: 4 }, modes())).toBeUndefined();
  });

  it('are a press and a release, so no selection is left held open', () => {
    expect(clickBytes({ button: 0, col: 3, row: 4 }, CLAUDE)).toBe(`${ESC}[<0;3;4M${ESC}[<0;3;4m`);
  });

  it('carry the modifiers a terminal carries', () => {
    expect(clickBytes({ button: 0, col: 3, row: 4, shiftKey: true }, CLAUDE)).toBe(
      `${ESC}[<4;3;4M${ESC}[<4;3;4m`,
    );
  });
});
