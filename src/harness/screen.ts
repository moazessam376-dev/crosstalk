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
  /** What the seat has asked its terminal to send. */
  modes?: ScreenModes;
  /** How many lines have scrolled off and are still held. */
  scrollback?: number;
  /**
   * Whether the seat is drawing on the alternate screen.
   *
   * Both agent CLIs are: they take the whole terminal and repaint it. It
   * matters to a reader because an alt-screen app owns its own history — there
   * is nothing above the top row to scroll to, in the hub or in a real
   * terminal, and the way up is the app's own scrolling, which is why the
   * mirror forwards the wheel.
   */
  alt?: boolean;
}

/**
 * The input modes the seat has asked for.
 *
 * A terminal is a duplex device: what it should *send* depends on what the
 * application has said it wants, and an application says so with the same
 * escape sequences it uses to draw. The parser was reading those sequences and
 * dropping them, so the hub had no way to know that Claude Code had asked for
 * mouse reporting and bracketed paste — and encoded every key as though a bare
 * VT100 were on the other end.
 *
 * Keeping them is what makes the mirror a terminal rather than a picture of
 * one. Measured off a real `claude --remote-control` session, it asks for
 * `?1049h ?1004h ?2004h ?1000h ?1002h ?1003h ?1006h` before it draws anything.
 */
export interface ScreenModes {
  /** DECCKM. Arrows are `ESC O A`, not `ESC [ A`. */
  applicationCursor: boolean;
  /** `?1004`. The app wants to be told when the operator looks at it. */
  focusReporting: boolean;
  /** `?2004`. Pasted text is wrapped, so it is never read as typing. */
  bracketedPaste: boolean;
  /** `?1000`/`?1002`/`?1003`. The app handles its own scrolling and clicks. */
  mouse: boolean;
  /** `?1006`. Report mouse in SGR form rather than the 223-column legacy one. */
  sgrMouse: boolean;
  /** `?1049`/`?47`/`?1047`. The app owns the screen and its own history. */
  alt: boolean;
  /** `?25`. Drawn only when the app wants a cursor drawn. */
  cursorVisible: boolean;
}

function defaultModes(): ScreenModes {
  return {
    applicationCursor: false,
    focusReporting: false,
    bracketedPaste: false,
    mouse: false,
    sgrMouse: false,
    alt: false,
    cursorVisible: true,
  };
}

/** A window onto the lines that have scrolled off. */
export interface ScrollbackPage {
  /** Total lines held, so a reader can size its scrollbar. */
  total: number;
  /** Index of the first line returned, counting from the oldest held line. */
  from: number;
  rows: ScreenRun[][];
}

/**
 * How many scrolled-off lines to keep.
 *
 * The grid was originally the whole memory: a line that scrolled off was
 * dropped, so a session that had printed two hundred lines could be asked for
 * thirty-one of them and the other hundred and sixty-nine did not exist
 * anywhere. That was not a UI limit — no front end could reach them.
 *
 * Keeping them is affordable in the packed run form, and only in that form.
 * Measured, ten thousand lines at 110 columns:
 *
 *   - as `Cell[][]`, the shape the live grid uses .......... 110 MB
 *   - as `ScreenRun[]`, the shape `snapshot()` already emits .. 17 MB
 *
 * so history costs about a tenth of what the obvious implementation costs, and
 * packing a row on its way out costs 1.1 microseconds — one percent of the
 * parse already being paid for it. Five thousand lines is ~9 MB for a seat
 * somebody is watching, which is the trade this number encodes: enough history
 * to find what an agent did an hour ago, not so much that four seats own a
 * gigabyte.
 */
export const DEFAULT_SCROLLBACK = 5_000;

export const DEFAULT_ROWS = 32;
export const DEFAULT_COLS = 110;

/**
 * The largest terminal this will build, whatever it is asked for.
 *
 * A ceiling rather than a preference. Geometry arrives from a browser measuring
 * itself, and a measurement that feeds back into what it measures runs away —
 * one live run did exactly that and took the daemon to a 2 GB heap. The
 * measurement is fixed; this is what makes the next such bug a wrong-looking
 * screen instead of a dead daemon.
 */
export const MAX_ROWS = 200;
export const MAX_COLS = 400;

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
  rows: number;
  cols: number;
  #grid: Cell[][];
  #row = 0;
  #col = 0;
  #attrs: Attrs = {};
  #saved: { row: number; col: number } | undefined;
  #version = 0;
  #modes = defaultModes();
  /**
   * Lines that have scrolled off the top, oldest first, already packed.
   *
   * A plain array with a shift-when-full rule rather than a ring: the buffer is
   * read far more often than it wraps, and every read wants oldest-first order,
   * which a ring has to rebuild each time.
   */
  #scrollback: ScreenRun[][] = [];
  readonly #scrollbackLimit: number;
  /**
   * The scrolling region, `DECSTBM`. Lines outside it hold still — which is how
   * a TUI keeps a status bar pinned while its transcript moves under it.
   */
  #top = 0;
  #bottom: number;
  /** Set by any write that touched a cell, the cursor, or the scroll position. */
  #dirty = false;
  /** The fingerprint `#version` was last bumped for. */
  #fingerprinted = 0;
  /** Bytes of an escape sequence split across two chunks. */
  #pending = '';

  constructor(
    rows: number = DEFAULT_ROWS,
    cols: number = DEFAULT_COLS,
    scrollbackLimit: number = DEFAULT_SCROLLBACK,
  ) {
    this.rows = Math.max(1, Math.min(MAX_ROWS, rows));
    this.cols = Math.max(1, Math.min(MAX_COLS, cols));
    this.#bottom = this.rows - 1;
    this.#scrollbackLimit = Math.max(0, scrollbackLimit);
    this.#grid = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => blank()),
    );
  }

  get version(): number {
    return this.#version;
  }

  get modes(): ScreenModes {
    return { ...this.#modes };
  }

  /** How many scrolled-off lines are held. */
  get held(): number {
    return this.#scrollback.length;
  }

  /**
   * A window onto the history, oldest line at index 0.
   *
   * Windowed rather than whole: ten thousand held lines are a megabyte of JSON,
   * and a reader scrolling up wants the screenful it is about to show, not the
   * session. `from` is clamped so a reader that asks past either end gets the
   * nearest real page instead of an error.
   */
  scrollback(from: number, count: number): ScrollbackPage {
    const total = this.#scrollback.length;
    const size = Math.max(0, Math.min(count, total));
    const start = Math.max(0, Math.min(Math.trunc(from), total - size));
    return { total, from: start, rows: this.#scrollback.slice(start, start + size) };
  }

  /**
   * Re-shape the grid to the geometry the operator is actually looking at.
   *
   * The pty and the mirror must agree — one constant used to guarantee that by
   * never changing, at the cost of every seat being 32×110 whatever the window
   * did. Now they agree because the same call resizes both, and this half
   * refuses a change it cannot honour rather than half-applying it.
   *
   * Rows are kept from the bottom, because the bottom is where the prompt is:
   * a shrink drops the oldest rows into scrollback rather than the newest onto
   * the floor. Columns do not reflow — a mirror that rewrapped would stop being
   * a mirror — so the application is left to repaint, which is what it does on
   * `SIGWINCH` anyway.
   */
  resize(rows: number, cols: number): void {
    const nextRows = Math.max(1, Math.min(MAX_ROWS, Math.trunc(rows) || 1));
    const nextCols = Math.max(1, Math.min(MAX_COLS, Math.trunc(cols) || 1));
    if (nextRows === this.rows && nextCols === this.cols) return;

    const resizedRow = (row: Cell[] | undefined): Cell[] => {
      const next = Array.from({ length: nextCols }, () => blank());
      if (row !== undefined) {
        for (let col = 0; col < Math.min(nextCols, row.length); col += 1) next[col] = row[col]!;
      }
      return next;
    };

    if (nextRows < this.rows) {
      // Anchored on the cursor, not on the physical bottom. A session that has
      // written five lines into a thirty-two row grid has twenty-seven blank
      // rows underneath the prompt, and keeping "the bottom" would keep the
      // blanks and scroll the prompt away.
      const end = Math.max(this.#row, nextRows - 1);
      const start = end - nextRows + 1;
      // Off the top, and into history — not deleted. A shrink is the one resize
      // that would otherwise lose content silently.
      for (const row of this.#grid.slice(0, start)) this.#remember(row);
      this.#grid = this.#grid.slice(start, start + nextRows).map(resizedRow);
      this.#row -= start;
    } else {
      this.#grid = this.#grid.map(resizedRow);
      while (this.#grid.length < nextRows) this.#grid.push(Array.from({ length: nextCols }, () => blank()));
    }

    this.rows = nextRows;
    this.cols = nextCols;
    this.#top = 0;
    this.#bottom = nextRows - 1;
    this.#row = Math.min(this.#row, nextRows - 1);
    this.#col = Math.min(this.#col, nextCols - 1);
    this.#dirty = true;
    // Straight to a bump: a resize changes what a watcher sees even when every
    // surviving cell is identical, and the fingerprint alone would not say so.
    this.#fingerprinted = this.#fingerprint();
    this.#version += 1;
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
      modes: this.modes,
      scrollback: this.#scrollback.length,
      ...(this.#modes.alt ? { alt: true } : {}),
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

  /**
   * Keep a line that is leaving the grid.
   *
   * Packed on the way in, not on the way out: the run form is what a reader is
   * served and what a diff compares, so doing it once here costs 1.1µs and
   * saves both. Alt-screen lines are dropped, exactly as a real terminal drops
   * them — an application that took the whole screen owns its own history, and
   * filling the operator's scrollback with a repainting TUI's intermediate
   * frames would bury the shell output that scrollback is for.
   */
  #remember(row: readonly Cell[]): void {
    if (this.#scrollbackLimit === 0 || this.#modes.alt) return;
    this.#scrollback.push(pack(row));
    if (this.#scrollback.length > this.#scrollbackLimit) {
      this.#scrollback.splice(0, this.#scrollback.length - this.#scrollbackLimit);
    }
  }

  #lineFeed(): void {
    this.#dirty = true;
    if (this.#row < this.#bottom) {
      this.#row += 1;
      return;
    }
    // At the bottom of the *region*, which is the whole screen unless the app
    // pinned a status bar. Only the top line of a full-height region is history
    // — a line scrolled out of a two-row region never left the screen.
    const evicted = this.#grid.splice(this.#top, 1)[0]!;
    if (this.#top === 0 && this.#bottom === this.rows - 1) this.#remember(evicted);
    this.#grid.splice(this.#bottom, 0, Array.from({ length: this.cols }, () => blank()));
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
      // Reverse index: up one line, scrolling down at the top of the region.
      if (this.#row === this.#top) {
        this.#grid.splice(this.#bottom, 1);
        this.#grid.splice(this.#top, 0, Array.from({ length: this.cols }, () => blank()));
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
      if (final !== 'h' && final !== 'l') return;
      const on = final === 'h';
      // Every parameter of a private-mode set, not just the first: an app that
      // writes `ESC [ ? 1000 ; 1006 h` is asking for two things, and reading
      // only the first is how mouse reporting ends up half-enabled.
      for (const mode of params) {
        if (mode === undefined) continue;
        if (mode === 1) this.#modes.applicationCursor = on;
        else if (mode === 25) this.#modes.cursorVisible = on;
        else if (mode === 1004) this.#modes.focusReporting = on;
        else if (mode === 2004) this.#modes.bracketedPaste = on;
        else if (mode === 1000 || mode === 1002 || mode === 1003) this.#modes.mouse = on;
        else if (mode === 1006) this.#modes.sgrMouse = on;
        else if (mode === 1049 || mode === 47 || mode === 1047) {
          this.#modes.alt = on;
          this.#clearAll();
          this.#moveTo(0, 0);
        }
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
      case 'r':
        // DECSTBM. Measured coming out of a real Claude Code session before it
        // draws anything, and previously dropped — so a status bar the app had
        // pinned scrolled away with the transcript.
        this.#setRegion((first ?? 1) - 1, (params[1] ?? this.rows) - 1);
        return;
      default:
        // Device status reports, window ops: no visible effect on a screen
        // nobody is typing into.
        return;
    }
  }

  #setRegion(top: number, bottom: number): void {
    const nextTop = Math.max(0, Math.min(this.rows - 1, top));
    const nextBottom = Math.max(nextTop, Math.min(this.rows - 1, bottom));
    this.#top = nextTop;
    this.#bottom = nextBottom;
    // Setting a region homes the cursor, which is the half of DECSTBM that
    // applications actually rely on.
    this.#moveTo(nextTop, 0);
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

  // Both of these move lines within the scrolling region: a line pushed off the
  // bottom of a pinned region has not left the screen, so it is not history.
  #insertLines(count: number): void {
    this.#dirty = true;
    if (this.#row < this.#top || this.#row > this.#bottom) return;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#bottom, 1);
      this.#grid.splice(this.#row, 0, Array.from({ length: this.cols }, () => blank()));
    }
  }

  #deleteLines(count: number): void {
    this.#dirty = true;
    if (this.#row < this.#top || this.#row > this.#bottom) return;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#row, 1);
      this.#grid.splice(this.#bottom, 0, Array.from({ length: this.cols }, () => blank()));
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
