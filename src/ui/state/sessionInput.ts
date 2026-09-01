/**
 * Everything the operator types at one seat, in the order they typed it.
 *
 * Each keystroke used to be its own `fetch`. A browser runs up to six requests
 * per host at once, so they raced, and the pty received them in whatever order
 * they happened to arrive. Measured in the hub, typing sixty-two characters as
 * fast as the event loop allowed:
 *
 *   typed:    0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
 *   received: 0125634789abcdefghijklmnopqrsuvtywxzABCDEGHIFJKLMNOPQRUSTXVWYZ
 *
 * That is a correctness bug wearing a performance bug's clothes, and it is why
 * the panel felt unlike a terminal: a real one cannot transpose your typing.
 *
 * One request in flight at a time fixes the order. Coalescing whatever arrived
 * while it was in flight fixes the cost — a burst of thirty keys becomes two
 * requests rather than thirty, which matters most on exactly the fast typing
 * that used to break. Bytes are concatenated rather than queued as messages
 * because that is what a terminal's input is: a stream, not a sequence of
 * envelopes.
 */

export interface SendResult {
  ok: boolean;
  reason?: string;
}

type Post = (payload: { keys: string }) => Promise<SendResult>;

export interface InputChannel {
  /** Queue bytes for the seat. Resolves once they have actually been sent. */
  write(bytes: string): Promise<SendResult>;
  /** Bytes waiting on the current request to finish. Zero when idle. */
  readonly pending: number;
}

export function openInputChannel(post: Post): InputChannel {
  let queued = '';
  let inFlight: Promise<SendResult> | undefined;
  let settle: ((result: SendResult) => void)[] = [];

  const drain = async (): Promise<SendResult> => {
    let last: SendResult = { ok: true };
    while (queued !== '') {
      const batch = queued;
      queued = '';
      const waiting = settle;
      settle = [];
      // Sent whole. A terminal has no notion of a partial write arriving
      // later, so a failure fails the whole batch and the operator is told
      // once rather than per character.
      last = await post({ keys: batch });
      for (const resolve of waiting) resolve(last);
    }
    inFlight = undefined;
    return last;
  };

  return {
    write(bytes: string): Promise<SendResult> {
      if (bytes === '') return Promise.resolve({ ok: true });
      queued += bytes;
      const answered = new Promise<SendResult>((resolve) => settle.push(resolve));
      // Started once, then re-entered by `drain` itself. Two callers arriving
      // in the same tick share the request, which is the coalescing.
      if (inFlight === undefined) inFlight = drain();
      return answered;
    },
    get pending(): number {
      return queued.length;
    },
  };
}
