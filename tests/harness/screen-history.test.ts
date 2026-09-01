import { describe, expect, it } from 'vitest';

import { DEFAULT_SCROLLBACK, Screen } from '../../src/harness/screen.js';

const ESC = '\u001b';
const CSI = `${ESC}[`;

/** The text of one packed row, so an assertion reads like the screen does. */
function line(runs: readonly { text: string }[]): string {
  return runs.map((run) => run.text).join('').replace(/\s+$/, '');
}

describe('Screen scrollback', () => {
  it('keeps the lines that scroll off, which used to be destroyed', () => {
    // The measured defect: 200 lines written, 31 readable, 169 gone. The grid
    // was the only memory, so no reader could ever reach them.
    const screen = new Screen(8, 40);
    for (let index = 1; index <= 200; index += 1) screen.write(`line-${index}\r\n`);

    expect(screen.held).toBe(200 - 7);
    const page = screen.scrollback(0, 3);
    expect(page.total).toBe(193);
    expect(page.rows.map(line)).toEqual(['line-1', 'line-2', 'line-3']);
  });

  it('holds a bounded amount, oldest first out', () => {
    const screen = new Screen(4, 20, 10);
    for (let index = 1; index <= 60; index += 1) screen.write(`line-${index}\r\n`);

    expect(screen.held).toBe(10);
    // 60 lines written, 3 still on the grid above the cursor, so the newest
    // held line is 57 and the buffer holds back to 48.
    expect(line(screen.scrollback(0, 1).rows[0]!)).toBe('line-48');
    expect(line(screen.scrollback(9, 1).rows[0]!)).toBe('line-57');
  });

  it('clamps a window that asks past either end rather than failing', () => {
    const screen = new Screen(4, 20);
    for (let index = 1; index <= 30; index += 1) screen.write(`line-${index}\r\n`);

    const past = screen.scrollback(9_999, 5);
    expect(past.rows).toHaveLength(5);
    expect(past.from).toBe(screen.held - 5);

    const before = screen.scrollback(-50, 2);
    expect(before.from).toBe(0);
    expect(line(before.rows[0]!)).toBe('line-1');
  });

  it('can be turned off, for a seat nobody will scroll back through', () => {
    const screen = new Screen(4, 20, 0);
    for (let index = 1; index <= 30; index += 1) screen.write(`line-${index}\r\n`);
    expect(screen.held).toBe(0);
    expect(screen.scrollback(0, 5).rows).toEqual([]);
  });

  it('does not fill history with an alt-screen app repainting itself', () => {
    // What a real terminal does, and for the same reason: an application that
    // took the whole screen owns its own history. Both agent CLIs enable
    // `?1049h` before they draw, and capturing their intermediate frames would
    // bury the shell output scrollback is actually for.
    const screen = new Screen(4, 20);
    screen.write('shell line\r\n');
    expect(screen.held).toBe(0);

    screen.write(`${CSI}?1049h`);
    for (let index = 1; index <= 40; index += 1) screen.write(`frame-${index}\r\n`);
    expect(screen.held).toBe(0);

    screen.write(`${CSI}?1049l`);
    for (let index = 1; index <= 10; index += 1) screen.write(`after-${index}\r\n`);
    expect(screen.held).toBeGreaterThan(0);
    expect(line(screen.scrollback(0, 1).rows[0]!)).toBe('after-1');
  });

  it('reports the depth on the snapshot, so a reader can size its scrollbar', () => {
    const screen = new Screen(4, 20);
    for (let index = 1; index <= 25; index += 1) screen.write(`line-${index}\r\n`);
    expect(screen.snapshot().scrollback).toBe(22);
  });

  it('defaults to a depth that holds a long session', () => {
    expect(DEFAULT_SCROLLBACK).toBeGreaterThanOrEqual(1_000);
  });
});

describe('Screen resize', () => {
  it('changes geometry rather than staying nailed to its first size', () => {
    const screen = new Screen(4, 10);
    screen.resize(10, 40);
    expect(screen.rows).toBe(10);
    expect(screen.cols).toBe(40);
    expect(screen.snapshot().rows).toHaveLength(10);
    expect(screen.snapshot().cols).toBe(40);
  });

  it('keeps the bottom of the screen when it shrinks — that is where the prompt is', () => {
    const screen = new Screen(6, 20);
    screen.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    screen.resize(3, 20);
    expect(screen.text()).toBe('three\nfour\nfive');
  });

  it('puts what a shrink pushed off into history rather than dropping it', () => {
    const screen = new Screen(6, 20);
    screen.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    screen.resize(3, 20);
    expect(screen.held).toBe(2);
    expect(screen.scrollback(0, 2).rows.map(line)).toEqual(['one', 'two']);
  });

  it('bumps the version, because a resize changes what a watcher sees', () => {
    const screen = new Screen(4, 20);
    screen.write('hello');
    const before = screen.version;
    screen.resize(8, 60);
    expect(screen.version).toBeGreaterThan(before);
  });

  it('is a no-op at the same geometry, so a reporting panel does not churn', () => {
    const screen = new Screen(4, 20);
    screen.write('hello');
    const before = screen.version;
    screen.resize(4, 20);
    expect(screen.version).toBe(before);
  });

  it('refuses a degenerate size instead of building an empty grid', () => {
    const screen = new Screen(4, 20);
    screen.resize(0, 0);
    expect(screen.rows).toBe(1);
    expect(screen.cols).toBe(1);
  });
});

describe('Screen modes', () => {
  it('starts as a plain terminal', () => {
    const modes = new Screen(4, 10).modes;
    expect(modes.applicationCursor).toBe(false);
    expect(modes.bracketedPaste).toBe(false);
    expect(modes.mouse).toBe(false);
    expect(modes.cursorVisible).toBe(true);
  });

  it('records what the seat asks for, so the hub can encode input correctly', () => {
    // Exactly what a real `claude --remote-control` session asks for, captured
    // off its pty. These used to be parsed and dropped, so the hub sent VT100
    // keys to an application that had asked for something else.
    const screen = new Screen(4, 10);
    screen.write(`${CSI}?1049h${CSI}?1004h${CSI}?2004h${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?1h`);
    const modes = screen.modes;
    expect(modes.alt).toBe(true);
    expect(modes.focusReporting).toBe(true);
    expect(modes.bracketedPaste).toBe(true);
    expect(modes.mouse).toBe(true);
    expect(modes.sgrMouse).toBe(true);
    expect(modes.applicationCursor).toBe(true);
  });

  it('reads every parameter of a combined set, not just the first', () => {
    const screen = new Screen(4, 10);
    screen.write(`${CSI}?1000;1006h`);
    expect(screen.modes.mouse).toBe(true);
    expect(screen.modes.sgrMouse).toBe(true);
  });

  it('turns them off again', () => {
    const screen = new Screen(4, 10);
    screen.write(`${CSI}?2004h${CSI}?1h`);
    screen.write(`${CSI}?2004l${CSI}?1l`);
    expect(screen.modes.bracketedPaste).toBe(false);
    expect(screen.modes.applicationCursor).toBe(false);
  });

  it('carries them on the snapshot, which is all the browser ever sees', () => {
    const screen = new Screen(4, 10);
    screen.write(`${CSI}?2004h`);
    expect(screen.snapshot().modes?.bracketedPaste).toBe(true);
  });

  it('cannot be mutated through the getter', () => {
    const screen = new Screen(4, 10);
    screen.modes.bracketedPaste = true;
    expect(screen.modes.bracketedPaste).toBe(false);
  });
});

describe('Screen scrolling region', () => {
  it('scrolls inside the region and leaves a pinned status bar alone', () => {
    // DECSTBM, which a real Claude Code session sets before it draws and which
    // this parser used to drop on the floor.
    const screen = new Screen(4, 12);
    screen.write('status\r\n');
    screen.write(`${CSI}2;4r`); // rows 2..4 scroll; row 1 is pinned
    screen.write(`${CSI}2;1Ha\r\nb\r\nc\r\nd`);
    expect(screen.text()).toBe('status\nb\nc\nd');
  });

  it('does not call a line scrolled out of a region history', () => {
    const screen = new Screen(4, 12);
    screen.write(`${CSI}2;4r`);
    for (let index = 1; index <= 20; index += 1) screen.write(`line-${index}\r\n`);
    expect(screen.held).toBe(0);
  });

  it('scrolls down at the top of the region on reverse index', () => {
    const screen = new Screen(4, 12);
    screen.write('a\r\nb\r\nc\r\nd');
    screen.write(`${CSI}1;1H${ESC}M`);
    expect(screen.text()).toBe('\na\nb\nc');
  });
});
