import { open, rename, writeFile, type FileHandle } from 'node:fs/promises';

import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';

function cloneEvent<T extends CrosstalkEvent | DraftEvent>(event: T): T {
  return structuredClone(event);
}

export class EventLog {
  #handle: FileHandle;
  #events: CrosstalkEvent[];
  #lastSeq: number;
  readonly #path: string;
  #appendTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  private constructor(handle: FileHandle, events: CrosstalkEvent[], lastSeq: number, path: string) {
    this.#handle = handle;
    this.#events = events;
    this.#lastSeq = lastSeq;
    this.#path = path;
  }

  static async open(path: string): Promise<EventLog> {
    const handle = await open(path, 'a+');
    const raw = await handle.readFile({ encoding: 'utf8' });
    const lines = raw.split('\n');
    const events: CrosstalkEvent[] = [];
    let lastSeq = 0;
    let offset = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const hasLineFeed = index < lines.length - 1;
      const lineBytes = Buffer.byteLength(line, 'utf8') + (hasLineFeed ? 1 : 0);

      if (line.length === 0) {
        offset += lineBytes;
        continue;
      }

      try {
        const event = JSON.parse(line) as CrosstalkEvent;
        events.push(event);
        lastSeq = event.seq;
        offset += lineBytes;
      } catch {
        const truncateHandle = await open(path, 'r+');
        try {
          await truncateHandle.truncate(offset);
        } finally {
          await truncateHandle.close();
        }
        break;
      }
    }

    return new EventLog(handle, events, lastSeq, path);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The lowest seq still in the file. Above 1 once anything has been archived. */
  get firstSeq(): number {
    return this.#events[0]?.seq ?? this.#lastSeq + 1;
  }

  /**
   * Move every event below `seq` out to `destPath`.
   *
   * The append-only rule says corrections are new events, never edits — and
   * nothing here edits or reorders anything. A completed run's lines move
   * whole, in order, into a file of their own; only which file holds them
   * changes. That is the argument, and it is the reason archiving is offered
   * for a finished run and refused for the current one.
   *
   * **`#lastSeq` is deliberately not recomputed.** It means "the highest seq
   * ever assigned", not "the highest still in this file". Deriving it from
   * `#events` after a move would hand the next append a seq that an archived
   * event already carries, and two events with one seq is the one thing the
   * total order cannot survive.
   *
   * Runs on the append chain, so no `append()` can land between reading the
   * events and replacing the file — a write racing an archive would otherwise
   * be written to an inode nobody will read again.
   */
  async archiveBefore(seq: number, destPath: string): Promise<{ moved: number; kept: number }> {
    const queued = this.#appendTail.then(async () => {
      const moving = this.#events.filter((event) => event.seq < seq);
      const keeping = this.#events.filter((event) => event.seq >= seq);
      if (moving.length === 0) return { moved: 0, kept: keeping.length };

      const text = (events: CrosstalkEvent[]): string =>
        events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');

      // Archive first and via a temp file, so a crash leaves the events in the
      // live log — duplicated at worst, which `reconcile` can see and fix.
      // Losing them is the failure that has no recovery.
      await writeFile(`${destPath}.tmp`, text(moving), 'utf8');
      await rename(`${destPath}.tmp`, destPath);

      // The handle is open `a+` on the original inode. Renaming over it would
      // leave every later append going to an unlinked file on POSIX, and would
      // fail outright on Windows — so it is closed, replaced, and reopened.
      await this.#handle.close();
      await writeFile(`${this.#path}.tmp`, text(keeping), 'utf8');
      await rename(`${this.#path}.tmp`, this.#path);
      this.#handle = await open(this.#path, 'a+');
      this.#events = keeping;

      return { moved: moving.length, kept: keeping.length };
    });
    this.#appendTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async append(draft: DraftEvent): Promise<CrosstalkEvent> {
    const draftCopy = cloneEvent(draft);
    const event: CrosstalkEvent = {
      ...draftCopy,
      seq: ++this.#lastSeq,
      ts: new Date().toISOString(),
    } as CrosstalkEvent;
    const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    const queued = this.#appendTail.then(async () => {
      await this.#handle.write(line);
      this.#events.push(cloneEvent(event));
    });
    this.#appendTail = queued.catch(() => {});

    await queued;
    return cloneEvent(event);
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#appendTail.then(() => this.#handle.close());
    await this.#closePromise;
  }
  async read(): Promise<CrosstalkEvent[]> {
    return this.#events.map((event) => cloneEvent(event));
  }

  async readFrom(seq: number): Promise<CrosstalkEvent[]> {
    return this.#events
      .filter((event) => event.seq >= seq)
      .map((event) => cloneEvent(event));
  }
}
