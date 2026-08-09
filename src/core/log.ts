import { open, type FileHandle } from 'node:fs/promises';

import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';

function cloneEvent<T extends CrosstalkEvent | DraftEvent>(event: T): T {
  return structuredClone(event);
}

export class EventLog {
  #handle: FileHandle;
  #events: CrosstalkEvent[];
  #lastSeq: number;

  private constructor(handle: FileHandle, events: CrosstalkEvent[], lastSeq: number) {
    this.#handle = handle;
    this.#events = events;
    this.#lastSeq = lastSeq;
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

    return new EventLog(handle, events, lastSeq);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  async append(draft: DraftEvent): Promise<CrosstalkEvent> {
    const draftCopy = cloneEvent(draft);
    const event: CrosstalkEvent = {
      ...draftCopy,
      seq: ++this.#lastSeq,
      ts: new Date().toISOString(),
    } as CrosstalkEvent;
    const line = `${JSON.stringify(event)}\n`;
    await this.#handle.write(Buffer.from(line, 'utf8'));
    this.#events.push(cloneEvent(event));
    return cloneEvent(event);
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
