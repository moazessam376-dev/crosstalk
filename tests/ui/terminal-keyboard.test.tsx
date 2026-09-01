// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Terminal } from '../../src/ui/session/Terminal.js';
import { keyBytes } from '../../src/ui/session/keys.js';

/**
 * The mirror takes the keyboard.
 *
 * It drew a terminal and then accepted four buttons' worth of input, which is
 * only any use for the four things guessed in advance. The operator's own words
 * on finding a seat stopped on a dialog: "I expect to have the same controls as
 * the actual CLI session, arrows move up and down and enter presses. I don't
 * know why I don't have that."
 */

const ESC = String.fromCharCode(27);

afterEach(cleanup);

const SCREEN = {
  version: 1,
  cols: 20,
  cursor: { row: 0, col: 0 },
  rows: [[{ text: 'No, exit' }]],
};

describe('typing into a mirrored terminal', () => {
  it('sends what a real key sends', () => {
    const onKey = vi.fn();
    render(createElement(Terminal, { screen: SCREEN, onKey }));

    const terminal = screen.getByTestId('terminal');
    fireEvent.keyDown(terminal, { key: 'ArrowDown' });
    fireEvent.keyDown(terminal, { key: 'Enter' });

    expect(onKey.mock.calls.map(([bytes]) => bytes)).toEqual([`${ESC}[B`, '\r']);
  });

  it('can be focused, so the keyboard has somewhere to go', () => {
    render(createElement(Terminal, { screen: SCREEN, onKey: vi.fn() }));
    expect(screen.getByTestId('terminal')).toHaveAttribute('tabindex', '0');
  });

  /**
   * A dead seat that still swallowed the keyboard would be a trap: no process
   * to receive anything, and the browser's own shortcuts eaten.
   */
  it('stays a picture when there is nowhere to send keys', () => {
    render(createElement(Terminal, { screen: SCREEN }));
    const terminal = screen.getByTestId('terminal');
    expect(terminal).not.toHaveAttribute('tabindex');
    expect(terminal).toHaveAttribute('role', 'log');
  });
});

describe('what a keystroke means', () => {
  it('encodes the keys a select dialog is driven with', () => {
    expect(keyBytes({ key: 'ArrowUp' })).toBe(`${ESC}[A`);
    expect(keyBytes({ key: 'ArrowDown' })).toBe(`${ESC}[B`);
    expect(keyBytes({ key: 'Enter' })).toBe('\r');
    expect(keyBytes({ key: 'Escape' })).toBe(ESC);
  });

  it('types ordinary characters as themselves', () => {
    expect(keyBytes({ key: 'y' })).toBe('y');
    expect(keyBytes({ key: ' ' })).toBe(' ');
    expect(keyBytes({ key: '/' })).toBe('/');
  });

  it('encodes Ctrl-C as the interrupt, not as the letter', () => {
    expect(keyBytes({ key: 'c', ctrlKey: true })).toBe(String.fromCharCode(3));
    expect(keyBytes({ key: 'd', ctrlKey: true })).toBe(String.fromCharCode(4));
    expect(keyBytes({ key: 'u', ctrlKey: true })).toBe(String.fromCharCode(21));
  });

  it('sends Backspace as DEL, which is what a terminal expects', () => {
    expect(keyBytes({ key: 'Backspace' })).toBe(String.fromCharCode(127));
  });

  /**
   * The line between the mirror and the browser. Eating Cmd would trap the
   * operator in a panel with no way to reload the page or copy what they read.
   */
  it('leaves the browser its own shortcuts', () => {
    expect(keyBytes({ key: 'r', metaKey: true })).toBeUndefined();
    expect(keyBytes({ key: 'c', metaKey: true })).toBeUndefined();
  });

  it('ignores a modifier pressed on its own', () => {
    expect(keyBytes({ key: 'Shift' })).toBeUndefined();
    expect(keyBytes({ key: 'Control' })).toBeUndefined();
  });

  /** Sending the name would type "F5" into the composer. */
  it('ignores keys it does not model rather than typing their names', () => {
    expect(keyBytes({ key: 'F5' })).toBeUndefined();
    expect(keyBytes({ key: 'AudioVolumeUp' })).toBeUndefined();
  });

  it('spells Alt-x the way a terminal always has', () => {
    expect(keyBytes({ key: 'b', altKey: true })).toBe(`${ESC}b`);
  });

  it('sends Shift-Tab as back-tab', () => {
    expect(keyBytes({ key: 'Tab', shiftKey: true })).toBe(`${ESC}[Z`);
    expect(keyBytes({ key: 'Tab' })).toBe('\t');
  });
});
