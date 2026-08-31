import { describe, expect, it } from 'vitest';

import { Screen } from '../../src/harness/screen.js';

const ESC = '\u001b';
const CSI = `${ESC}[`;

describe('Screen', () => {
  it('writes plain text into the grid', () => {
    const screen = new Screen(4, 10);
    screen.write('hello');
    expect(screen.text()).toBe('hello');
  });

  it('wraps at the right margin instead of losing characters', () => {
    const screen = new Screen(3, 4);
    screen.write('abcdef');
    expect(screen.text()).toBe('abcd\nef');
  });

  it('scrolls when a line feed runs off the bottom', () => {
    const screen = new Screen(2, 8);
    screen.write('one\ntwo\nthree');
    expect(screen.text()).toBe('two\nthree');
  });

  it('overwrites in place on carriage return, as a progress line does', () => {
    const screen = new Screen(2, 20);
    screen.write('Building 10%\rBuilding 90%');
    expect(screen.text()).toBe('Building 90%');
  });

  it('positions the cursor from CSI H', () => {
    const screen = new Screen(4, 10);
    screen.write(`${CSI}3;5Hx`);
    expect(screen.text()).toBe('\n\n    x');
  });

  it('clears the screen on CSI 2J', () => {
    const screen = new Screen(3, 10);
    screen.write('junk\nmore');
    screen.write(`${CSI}2J${CSI}1;1Hclean`);
    expect(screen.text()).toBe('clean');
  });

  it('erases to end of line on CSI K, which is how a TUI repaints one row', () => {
    const screen = new Screen(2, 20);
    screen.write('stale text here');
    screen.write(`${CSI}1;7H${CSI}Kfresh`);
    expect(screen.text()).toBe('stale fresh');
  });

  it('drops sequences it does not implement rather than printing them', () => {
    const screen = new Screen(2, 20);
    screen.write(`${CSI}?25lhidden${CSI}?25h`);
    expect(screen.text()).toBe('hidden');
  });

  it('skips an OSC title without swallowing what follows', () => {
    const screen = new Screen(2, 20);
    screen.write(`${ESC}]0;a window title\u0007after`);
    expect(screen.text()).toBe('after');
  });

  it('holds an escape split across two chunks', () => {
    const screen = new Screen(2, 20);
    // The pty handed us half a cursor-position sequence.
    screen.write(`ab${CSI}1`);
    screen.write(';1Hz');
    expect(screen.text()).toBe('zb');
  });

  it('recovers rather than stalling when a lone ESC never completes', () => {
    const screen = new Screen(2, 40);
    screen.write(`${CSI}${'9'.repeat(80)}`);
    screen.write('visible');
    expect(screen.text()).toContain('visible');
  });

  it('folds an alt-screen switch into a clear', () => {
    const screen = new Screen(3, 20);
    screen.write("shell's last line");
    screen.write(`${CSI}?1049h`);
    screen.write('tui');
    expect(screen.text()).toBe('tui');
  });

  describe('version', () => {
    it('ticks when something visible changed', () => {
      const screen = new Screen(2, 10);
      const before = screen.version;
      screen.write('x');
      expect(screen.version).toBeGreaterThan(before);
    });

    /**
     * The whole reason polling is cheap. A TUI redraws its frame continuously;
     * if every repaint counted as a change, the hub would ship a full grid
     * several times a second per seat for a screen nobody could see move.
     */
    it('does not tick when a repaint lands identical bytes', () => {
      const screen = new Screen(2, 20);
      screen.write(`${CSI}1;1Hsteady`);
      const settled = screen.version;
      screen.write(`${CSI}1;1Hsteady`);
      expect(screen.version).toBe(settled);
    });

    it('does not tick on a sequence that draws nothing', () => {
      const screen = new Screen(2, 20);
      screen.write('text');
      const settled = screen.version;
      screen.write(`${CSI}?25l${CSI}?25h`);
      expect(screen.version).toBe(settled);
    });
  });

  describe('snapshot', () => {
    it('splits a row into runs at each attribute change', () => {
      const screen = new Screen(1, 20);
      screen.write(`plain${CSI}31mred${CSI}0mplain`);
      const [row] = screen.snapshot().rows;
      expect(row?.map((run) => run.text)).toEqual(['plain', 'red', 'plain']);
      expect(row?.[1]?.fg).toBe(1);
    });

    it('folds truecolour to a palette index so the mirror stays theme-consistent', () => {
      const screen = new Screen(1, 20);
      screen.write(`${CSI}38;2;255;0;0mred`);
      const run = screen.snapshot().rows[0]?.[0];
      expect(run?.fg).toBe(196);
    });

    it('drops trailing blanks, which are most of a padded TUI row', () => {
      const screen = new Screen(1, 200);
      screen.write('short');
      const [row] = screen.snapshot().rows;
      expect(row?.map((run) => run.text).join('')).toBe('short');
    });

    it('reports the cursor so the mirror can draw one', () => {
      const screen = new Screen(5, 20);
      screen.write(`${CSI}4;3Hx`);
      expect(screen.snapshot().cursor).toEqual({ row: 3, col: 3 });
    });
  });
});
