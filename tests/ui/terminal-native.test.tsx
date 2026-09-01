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
    expect(terminal.getAttribute('role')).toBe('log');
    expect(terminal.getAttribute('tabindex')).toBeNull();
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
    const runs = [...screen.getByTestId('terminal').querySelectorAll('.term-run')];
    const colours = runs.map((run) => (run as HTMLElement).style.color);
    expect(new Set(colours).size).toBe(3);
    expect(colours.every((colour) => colour !== '')).toBe(true);
  });

  it('still takes the first sixteen from the theme', () => {
    render(createElement(Terminal, { screen: aScreen({ rows: [[{ text: 'x', fg: 3 }]] }) }));
    const run = screen.getByTestId('terminal').querySelector('.term-run') as HTMLElement;
    expect(run.style.color).toContain('--term-3');
  });

  it('swaps a reversed run rather than letting its own colour win', () => {
    render(
      createElement(Terminal, {
        screen: aScreen({ rows: [[{ text: 'sel', fg: 114, bg: 17, inverse: true }]] }),
      }),
    );
    const run = screen.getByTestId('terminal').querySelector('.term-run') as HTMLElement;
    // Foreground and background have traded places; neither is empty.
    expect(run.style.color).not.toBe('');
    expect(run.style.background).not.toBe('');
    expect(run.style.color).not.toBe(run.style.background);
  });
});
