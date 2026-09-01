// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScreenModes } from '../../src/harness/screen.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Terminal } from '../../src/ui/session/Terminal.js';
import type { MirrorScreen } from '../../src/ui/state/useSessionMirror.js';

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

function aScreen(overrides: Partial<MirrorScreen> = {}): MirrorScreen {
  return {
    version: 1,
    cols: 20,
    cursor: { row: 0, col: 0 },
    rows: [[{ text: 'hello' }], [{ text: 'world' }]],
    ...overrides,
  };
}

/**
 * A run's inline colours.
 *
 * Read off the `style` attribute rather than through `HTMLElement`: the frozen
 * test config omits the DOM lib, so the element's own typed properties are not
 * available here.
 */
function styleOf(element: { getAttribute(name: string): string | null }): { color: string; background: string } {
  const declarations = (element.getAttribute('style') ?? '').split(';');
  const read = (property: string): string => {
    const found = declarations.find((entry) => entry.trim().startsWith(`${property}:`));
    return found === undefined ? '' : found.slice(found.indexOf(':') + 1).trim();
  };
  return { color: read('color'), background: read('background') };
}

afterEach(cleanup);

describe('the mirrored terminal takes what a terminal takes', () => {
  it('sends an arrow the way the application asked to receive it', () => {
    // The reported symptom: a suggestion menu that would not move under the
    // arrow keys. An application in application-cursor mode does not read
    // `ESC [ A` as an arrow at all.
    const onKey = vi.fn();
    render(
      createElement(Terminal, {
        screen: aScreen({ modes: modes({ applicationCursor: true }) }),
        onKey,
      }),
    );
    fireEvent.keyDown(screen.getByTestId('terminal'), { key: 'ArrowUp' });
    expect(onKey).toHaveBeenCalledWith(`${ESC}OA`);
  });

  it('pastes, which Cmd-V on a non-editable div could never do', () => {
    const onKey = vi.fn();
    render(
      createElement(Terminal, {
        screen: aScreen({ modes: modes({ bracketedPaste: true }) }),
        onKey,
      }),
    );
    fireEvent.paste(screen.getByTestId('terminal'), {
      clipboardData: { getData: () => 'one\ntwo' },
    });
    expect(onKey).toHaveBeenCalledWith(`${ESC}[200~one\ntwo${ESC}[201~`);
  });

  it('ignores an empty paste rather than sending an empty fence', () => {
    const onKey = vi.fn();
    render(createElement(Terminal, { screen: aScreen({ modes: modes({ bracketedPaste: true }) }), onKey }));
    fireEvent.paste(screen.getByTestId('terminal'), { clipboardData: { getData: () => '' } });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('forwards the wheel, which is how an alt-screen CLI scrolls its transcript', () => {
    const onKey = vi.fn();
    render(
      createElement(Terminal, {
        screen: aScreen({ alt: true, modes: modes({ mouse: true, sgrMouse: true, alt: true }) }),
        onKey,
      }),
    );
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaY: -120, clientX: 0, clientY: 0 });
    expect(onKey).toHaveBeenCalledWith(expect.stringContaining(`${ESC}[<64;`));
  });

  it('leaves the wheel to the browser when the seat does not track a mouse', () => {
    const onKey = vi.fn();
    render(createElement(Terminal, { screen: aScreen({ modes: modes() }), onKey }));
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaY: -120, clientX: 0, clientY: 0 });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('reports focus only to a seat that asked about it', () => {
    const onKey = vi.fn();
    const { unmount } = render(
      createElement(Terminal, { screen: aScreen({ modes: modes({ focusReporting: true }) }), onKey }),
    );
    fireEvent.focus(screen.getByTestId('terminal'));
    expect(onKey).toHaveBeenCalledWith(`${ESC}[I`);
    unmount();

    const quiet = vi.fn();
    render(createElement(Terminal, { screen: aScreen({ modes: modes() }), onKey: quiet }));
    fireEvent.focus(screen.getByTestId('terminal'));
    expect(quiet).not.toHaveBeenCalled();
  });

  it('draws no cursor for a seat that hid it', () => {
    render(createElement(Terminal, { screen: aScreen({ modes: modes({ cursorVisible: false }) }) }));
    expect(screen.queryByTestId('terminal-cursor')).toBeNull();
  });

  it('is still a picture of a terminal when nothing can receive input', () => {
    render(createElement(Terminal, { screen: aScreen() }));
    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('role', 'log');
    expect(terminal).not.toHaveAttribute('tabindex');
  });
});

describe('colour fidelity', () => {
  it('keeps colours that used to collapse into one', () => {
    // Measured off a real Claude Code screen: five distinct colours, three
    // after the old sixteen-token fold, with 114, 153 and 174 all becoming the
    // same white. A menu marking its selection with colour loses it entirely.
    render(
      createElement(Terminal, {
        screen: aScreen({
          rows: [
            [
              { text: 'a', fg: 114 },
              { text: 'b', fg: 153 },
              { text: 'c', fg: 174 },
            ],
          ],
        }),
      }),
    );
    const colours = ['a', 'b', 'c'].map((text) => styleOf(screen.getByText(text)).color);
    expect(new Set(colours).size).toBe(3);
    expect(colours.every((colour) => colour !== '')).toBe(true);
  });

  it('still takes the first sixteen from the theme', () => {
    render(createElement(Terminal, { screen: aScreen({ rows: [[{ text: 'x', fg: 3 }]] }) }));
    expect(styleOf(screen.getByText('x')).color).toContain('--term-3');
  });

  it('swaps a reversed run rather than letting its own colour win', () => {
    render(
      createElement(Terminal, {
        screen: aScreen({ rows: [[{ text: 'sel', fg: 114, bg: 17, inverse: true }]] }),
      }),
    );
    // Foreground and background have traded places; neither is empty.
    const style = styleOf(screen.getByText('sel'));
    expect(style.color).not.toBe('');
    expect(style.background).not.toBe('');
    expect(style.color).not.toBe(style.background);
  });
});

describe('reporting how big the terminal is', () => {
  /**
   * The measurement must not depend on what the seat drew.
   *
   * Taking a cell width from a rendered row is a feedback loop: a row is as
   * wide as its content, so a wider terminal makes wider rows, which makes the
   * cell look wider, which asks for a wider terminal. One live run with that
   * loop resized the pty continuously and killed the daemon at a 2 GB heap.
   */
  it('measures against a gauge whose width the seat cannot change', () => {
    const seen: [number, number][] = [];
    const { rerender } = render(
      createElement(Terminal, {
        screen: aScreen({ cols: 20, rows: [[{ text: 'x'.repeat(20) }]] }),
        onGeometry: (rows: number, cols: number) => seen.push([rows, cols]),
      }),
    );
    const first = seen.length;

    // The seat draws something far wider. Nothing about the panel changed, so
    // nothing about the reported geometry may change either.
    rerender(
      createElement(Terminal, {
        screen: aScreen({ cols: 20, rows: [[{ text: 'y'.repeat(400) }]] }),
        onGeometry: (rows: number, cols: number) => seen.push([rows, cols]),
      }),
    );

    const after = seen.slice(first);
    for (const [, cols] of after) expect(cols).toBe(seen[0]?.[1]);
  });

  it('renders the gauge, since the measurement depends on it', () => {
    render(createElement(Terminal, { screen: aScreen() }));
    const terminal = screen.getByTestId('terminal') as unknown as {
      querySelector(selector: string): { textContent: string | null } | null;
    };
    const gauge = terminal.querySelector('.terminal-gauge');
    expect(gauge).not.toBeNull();
    expect(gauge?.textContent?.length).toBeGreaterThan(1);
  });

  it('says nothing when nobody asked', () => {
    // No `onGeometry`, no measuring, no resize traffic for a panel that is only
    // being read.
    expect(() => render(createElement(Terminal, { screen: aScreen() }))).not.toThrow();
  });
});
