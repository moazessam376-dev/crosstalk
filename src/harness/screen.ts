/**
 * A terminal screen, reconstructed from what a CLI writes to its pty.
 *
 * An interactive harness is a TUI: it does not append lines, it repaints a
 * grid. Its output is a stream of cursor moves, erases and rewrites, and the
 * same region is overwritten many times per second. Piping those bytes to a
 * browser and calling it a mirror produces garbage — the escape sequences are
 * most of the traffic and none of the meaning.
 *
 * So the screen is reconstructed here, next to the pty, and the hub is served
 * the *result*. Three things follow from that, all of them the point:
 *
 *  - **Cost is bounded by the screen, not the session.** A seat that has been
 *    running for six hours has the same grid as one that started a minute ago.
 *    Polling it is O(screen), and a session that scrolled a megabyte through a
 *    2 KB window costs 2 KB to look at.
 *  - **`version` makes polling nearly free.** It ticks only when a write
 *    changed something a reader could see, so an idle seat answers "unchanged"
 *    and sends no grid at all. A repaint that lands identical bytes — which a
 *    TUI does constantly, redrawing a spinner frame that did not move — is not
 *    a change.
 *  - **It is testable without a terminal.** The parser takes a string and the
 *    snapshot is data, so the escape handling is checked directly rather than
 *    inferred from a screenshot.
 *
 * The subset implemented is the subset TUIs actually emit. Anything else is
 * skipped rather than printed: an unrecognised sequence rendered literally
 * would put `[?25l` in the middle of the operator's mirror, which is worse
 * than dropping it.
 */

const ESC = '\u001b';
const BEL = '\u0007';

/** Visible attributes of a cell. Packed into runs on the way out. */
interface Attrs {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

interface Cell {
  ch: string;
  attrs: Attrs;
}

export interface ScreenRun {
  text: string;
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface ScreenSnapshot {
  /** Ticks only when a write changed something visible. */
  version: number;
  rows: ScreenRun[][];
  cursor: { row: number; col: number };
  cols: number;
}

export const DEFAULT_ROWS = 32;
export const DEFAULT_COLS = 110;

function blank(): Cell {
  return { ch: ' ', attrs: {} };
}

function sameAttrs(left: Attrs, right: Attrs): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.inverse === right.inverse
  );
}

export class Screen {
  readonly rows: number;
  readonly cols: number;
  readonly #grid: Cell[][];
  #row = 0;
  #col = 0;
  #attrs: Attrs = {};
  #saved: { row: number; col: number } | undefined;
  #version = 0;
  /** Set by any write that touched a cell, the cursor, or the scroll position. */
  #dirty = false;
  /** The fingerprint `#version` was last bumped for. */
  #fingerprinted = 0;
  /** Bytes of an escape sequence split across two chunks. */
  #pending = '';

  constructor(rows: number = DEFAULT_ROWS, cols: number = DEFAULT_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.#grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => blank()));
  }

  get version(): number {
    return this.#version;
  }

  /**
   * Feed the screen whatever came off the pty.
   *
   * A chunk boundary can fall inside an escape sequence — pty reads are sized
   * by the kernel, not by the writer — so an incomplete tail is held over
   * rather than parsed as text. Without this, roughly one repaint in a
   * thousand prints a bare `[38;5;2` into the middle of the mirror.
   */
  write(chunk: string): void {
    const text = this.#pending + chunk;
    this.#pending = '';
    let index = 0;

    while (index < text.length) {
      const ch = text[index]!;

      if (ch === ESC) {
        const consumed = this.#escape(text, index);
        if (consumed === -1) {
          // Incomplete. Hold it, unless it is so long it cannot be a real
          // sequence — a stuck prefix would swallow every later write.
          const tail = text.slice(index);
          this.#pending = tail.length > 64 ? '' : tail;
          break;
        }
        index += consumed;
        continue;
      }

      index += 1;
      if (ch === '\n') {
        // Linefeed returns the carriage too. A pty with `onlcr` set — which is
        // every pty a CLI is handed — turns the writer's `\n` into `\r\n`, so
        // for pty input the CR is redundant and harmless. It matters for the
        // other source: a harness captured without a pty writes bare LF, and a
        // strictly-correct emulator renders that as a staircase.
        this.#col = 0;
        this.#lineFeed();
      } else if (ch === '\r') {
        if (this.#col !== 0) this.#dirty = true;
        this.#col = 0;
      } else if (ch === '\b') {
        if (this.#col > 0) {
          this.#col -= 1;
          this.#dirty = true;
        }
      } else if (ch === '\t') {
        this.#moveTo(this.#row, Math.min(this.cols - 1, (Math.floor(this.#col / 8) + 1) * 8));
      } else if (ch >= ' ') {
        this.#put(ch);
      }
      // Bell and the other C0 controls draw nothing.
    }

    // `#dirty` says a write *touched* something; it does not say the screen
    // ends up looking different. A TUI repaints by homing the cursor and
    // rewriting the same frame, which touches every cell and changes nothing.
    // Ticking on that would ship a full grid to every watcher several times a
    // second for a screen nobody could see move — so the fingerprint of the
    // finished screen is what decides, and `#dirty` only says when to bother
    // computing it.
    if (this.#dirty) {
      this.#dirty = false;
      const fingerprint = this.#fingerprint();
      if (fingerprint !== this.#fingerprinted) {
        this.#fingerprinted = fingerprint;
        this.#version += 1;
      }
    }
  }

  /**
   * A cheap hash of everything a watcher can see: every cell's character and
   * attributes, plus the cursor.
   *
   * FNV-1a over the grid rather than a string compare, so a repaint costs one
   * pass and no allocation. Collisions would show as a missed frame; at 32 bits
   * over a screen that changes a few times a second, that is not a rate anyone
   * will meet.
   */
  #fingerprint(): number {
    let hash = 0x811c9dc5;
    const mix = (value: number): void => {
      hash ^= value;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    };
    for (const row of this.#grid) {
      for (const cell of row) {
        mix(cell.ch.charCodeAt(0));
        mix(cell.attrs.fg ?? 0xff);
        mix(cell.attrs.bg ?? 0xff);
        mix((cell.attrs.bold ? 1 : 0) | (cell.attrs.dim ? 2 : 0) | (cell.attrs.inverse ? 4 : 0));
      }
    }
    mix(this.#row);
    mix(this.#col);
    return hash;
  }

  snapshot(): ScreenSnapshot {
    return {
      version: this.#version,
      rows: this.#grid.map((row) => pack(row)),
      cursor: { row: this.#row, col: this.#col },
      cols: this.cols,
    };
  }

  /** The screen as plain text, right-trimmed. For tests and for terminal tooling. */
  text(): string {
    return this.#grid
      .map((row) => row.map((cell) => cell.ch).join('').replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n+$/, '');
  }

  #put(ch: string): void {
    if (this.#col >= this.cols) {
      this.#col = 0;
      this.#lineFeed();
    }
    const cell = this.#grid[this.#row]![this.#col]!;
    if (cell.ch !== ch || !sameAttrs(cell.attrs, this.#attrs)) this.#dirty = true;
    cell.ch = ch;
    cell.attrs = this.#attrs;
    this.#col += 1;
  }

  #lineFeed(): void {
    this.#dirty = true;
    if (this.#row < this.rows - 1) {
      this.#row += 1;
      return;
    }
    this.#grid.shift();
    this.#grid.push(Array.from({ length: this.cols }, () => blank()));
  }

  #moveTo(row: number, col: number): void {
    const nextRow = Math.max(0, Math.min(this.rows - 1, row));
    const nextCol = Math.max(0, Math.min(this.cols - 1, col));
    if (nextRow !== this.#row || nextCol !== this.#col) this.#dirty = true;
    this.#row = nextRow;
    this.#col = nextCol;
  }

  /**
   * Parse one escape sequence at `at`. Returns how many characters it consumed,
   * or -1 when the sequence is not yet complete in this chunk.
   */
  #escape(text: string, at: number): number {
    const next = text[at + 1];
    if (next === undefined) return -1;

    // OSC: ESC ] … BEL, or ESC ] … ESC \. Window titles, mostly. Skipped whole.
    if (next === ']') {
      for (let index = at + 2; index < text.length; index += 1) {
        if (text[index] === BEL) return index - at + 1;
        if (text[index] === ESC && text[index + 1] === '\\') return index - at + 2;
      }
      return -1;
    }

    // CSI: ESC [ params intermediates final
    if (next === '[') {
      let index = at + 2;
      while (index < text.length && /[\d;?<>! ]/.test(text[index]!)) index += 1;
      if (index >= text.length) return -1;
      const final = text[index]!;
      this.#csi(text.slice(at + 2, index), final);
      return index - at + 1;
    }

    // ESC ( B and friends: charset selection. Two characters, no visible effect.
    if (next === '(' || next === ')' || next === '#') {
      return text.length > at + 2 ? 3 : -1;
    }

    if (next === '7') {
      this.#saved = { row: this.#row, col: this.#col };
      return 2;
    }
    if (next === '8') {
      if (this.#saved !== undefined) this.#moveTo(this.#saved.row, this.#saved.col);
      return 2;
    }
    if (next === 'M') {
      // Reverse index: up one line, scrolling down at the top.
      if (this.#row === 0) {
        this.#grid.pop();
        this.#grid.unshift(Array.from({ length: this.cols }, () => blank()));
        this.#dirty = true;
      } else {
        this.#moveTo(this.#row - 1, this.#col);
      }
      return 2;
    }

    // Anything else: drop the ESC and its immediate byte.
    return 2;
  }

  #csi(rawParams: string, final: string): void {
    // `?` marks a private mode (cursor visibility, alt screen, bracketed
    // paste). None of them draw, and an alt-screen switch is handled as a clear
    // so a TUI entering it does not inherit the shell's last screen.
    const priv = rawParams.startsWith('?');
    const params = rawParams
      .replace(/^[?<>!]/, '')
      .trim()
      .split(';')
      .map((part) => (part === '' ? undefined : Number(part)));
    const first = params[0];

    if (priv) {
      if ((first === 1049 || first === 47 || first === 1047) && (final === 'h' || final === 'l')) {
        this.#clearAll();
        this.#moveTo(0, 0);
      }
      return;
    }

    switch (final) {
      case 'H':
      case 'f':
        this.#moveTo((first ?? 1) - 1, (params[1] ?? 1) - 1);
        return;
      case 'A':
        this.#moveTo(this.#row - (first ?? 1), this.#col);
        return;
      case 'B':
        this.#moveTo(this.#row + (first ?? 1), this.#col);
        return;
      case 'C':
        this.#moveTo(this.#row, this.#col + (first ?? 1));
        return;
      case 'D':
        this.#moveTo(this.#row, this.#col - (first ?? 1));
        return;
      case 'E':
        this.#moveTo(this.#row + (first ?? 1), 0);
        return;
      case 'F':
        this.#moveTo(this.#row - (first ?? 1), 0);
        return;
      case 'G':
        this.#moveTo(this.#row, (first ?? 1) - 1);
        return;
      case 'd':
        this.#moveTo((first ?? 1) - 1, this.#col);
        return;
      case 'J':
        this.#eraseDisplay(first ?? 0);
        return;
      case 'K':
        this.#eraseLine(first ?? 0);
        return;
      case 'L':
        this.#insertLines(first ?? 1);
        return;
      case 'M':
        this.#deleteLines(first ?? 1);
        return;
      case 'P':
        this.#deleteChars(first ?? 1);
        return;
      case 'X':
        this.#eraseChars(first ?? 1);
        return;
      case 's':
        this.#saved = { row: this.#row, col: this.#col };
        return;
      case 'u':
        if (this.#saved !== undefined) this.#moveTo(this.#saved.row, this.#saved.col);
        return;
      case 'm':
        this.#sgr(params);
        return;
      default:
        // Device status reports, scroll regions, window ops: no visible effect
        // on a screen nobody is typing into.
        return;
    }
  }

  #sgr(params: readonly (number | undefined)[]): void {
    if (params.length === 0 || (params.length === 1 && params[0] === undefined)) {
      this.#attrs = {};
      return;
    }
    let attrs: Attrs = { ...this.#attrs };
    for (let index = 0; index < params.length; index += 1) {
      const code = params[index] ?? 0;
      if (code === 0) attrs = {};
      else if (code === 1) attrs.bold = true;
      else if (code === 2) attrs.dim = true;
      else if (code === 7) attrs.inverse = true;
      else if (code === 22) {
        delete attrs.bold;
        delete attrs.dim;
      } else if (code === 27) delete attrs.inverse;
      else if (code >= 30 && code <= 37) attrs.fg = code - 30;
      else if (code >= 90 && code <= 97) attrs.fg = code - 90 + 8;
      else if (code === 39) delete attrs.fg;
      else if (code >= 40 && code <= 47) attrs.bg = code - 40;
      else if (code >= 100 && code <= 107) attrs.bg = code - 100 + 8;
      else if (code === 49) delete attrs.bg;
      else if (code === 38 || code === 48) {
        // 256-colour and truecolour. Both fold to a palette index: the mirror
        // renders against the hub's own theme rather than trying to reproduce
        // whatever profile the operator's terminal happens to carry.
        const mode = params[index + 1];
        if (mode === 5) {
          const value = params[index + 2] ?? 0;
          if (code === 38) attrs.fg = value;
          else attrs.bg = value;
          index += 2;
        } else if (mode === 2) {
          const red = params[index + 2] ?? 0;
          const green = params[index + 3] ?? 0;
          const blue = params[index + 4] ?? 0;
          const folded =
            16 +
            36 * Math.round((red / 255) * 5) +
            6 * Math.round((green / 255) * 5) +
            Math.round((blue / 255) * 5);
          if (code === 38) attrs.fg = folded;
          else attrs.bg = folded;
          index += 4;
        }
      }
    }
    this.#attrs = attrs;
  }

  #clearAll(): void {
    for (const row of this.#grid) {
      for (let col = 0; col < this.cols; col += 1) row[col] = blank();
    }
    this.#dirty = true;
  }

  #eraseDisplay(mode: number): void {
    this.#dirty = true;
    if (mode === 2 || mode === 3) {
      this.#clearAll();
      return;
    }
    if (mode === 0) {
      this.#eraseLine(0);
      for (let row = this.#row + 1; row < this.rows; row += 1) {
        for (let col = 0; col < this.cols; col += 1) this.#grid[row]![col] = blank();
      }
      return;
    }
    this.#eraseLine(1);
    for (let row = 0; row < this.#row; row += 1) {
      for (let col = 0; col < this.cols; col += 1) this.#grid[row]![col] = blank();
    }
  }

  #eraseLine(mode: number): void {
    this.#dirty = true;
    const row = this.#grid[this.#row]!;
    const from = mode === 0 ? this.#col : 0;
    const to = mode === 1 ? this.#col + 1 : this.cols;
    for (let col = from; col < to && col < this.cols; col += 1) row[col] = blank();
  }

  #eraseChars(count: number): void {
    this.#dirty = true;
    const row = this.#grid[this.#row]!;
    for (let col = this.#col; col < Math.min(this.cols, this.#col + count); col += 1) row[col] = blank();
  }

  #deleteChars(count: number): void {
    this.#dirty = true;
    const row = this.#grid[this.#row]!;
    row.splice(this.#col, count);
    while (row.length < this.cols) row.push(blank());
  }

  #insertLines(count: number): void {
    this.#dirty = true;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#row, 0, Array.from({ length: this.cols }, () => blank()));
      this.#grid.splice(this.rows, 1);
    }
  }

  #deleteLines(count: number): void {
    this.#dirty = true;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#row, 1);
      this.#grid.splice(this.rows - 1, 0, Array.from({ length: this.cols }, () => blank()));
    }
  }
}

/**
 * Cells to runs, trailing blanks dropped.
 *
 * A TUI pads every line to the full width, so a naive encoding spends most of
 * its bytes on spaces nobody can see. Trimming the tail is what keeps a
 * snapshot of a mostly-empty screen small.
 */
function pack(row: readonly Cell[]): ScreenRun[] {
  let end = row.length;
  while (end > 0) {
    const cell = row[end - 1]!;
    if (cell.ch !== ' ' || cell.attrs.bg !== undefined || cell.attrs.inverse === true) break;
    end -= 1;
  }
  const runs: ScreenRun[] = [];
  for (let col = 0; col < end; col += 1) {
    const cell = row[col]!;
    const last = runs[runs.length - 1];
    if (last !== undefined && sameAttrs(cell.attrs, last)) {
      last.text += cell.ch;
      continue;
    }
    runs.push({ text: cell.ch, ...cell.attrs });
  }
  return runs;
}
