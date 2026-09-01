import { describe, expect, it } from 'vitest';

import { openInputChannel } from '../../src/ui/state/sessionInput.js';

/** A transport that answers out of order, the way parallel requests do. */
function racingPost(sent: string[], delays: number[] = []) {
  let call = 0;
  return async (payload: { keys: string }) => {
    const index = call;
    call += 1;
    await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
    sent.push(payload.keys);
    return { ok: true };
  };
}

describe('the seat input channel', () => {
  it('delivers a burst in the order it was typed', async () => {
    // The measured defect: sixty-two characters typed, transposed on arrival,
    // because each keystroke was its own racing request.
    const sent: string[] = [];
    const channel = openInputChannel(racingPost(sent, [40, 0, 0, 0, 0]));
    const word = '0123456789abcdefghijklmnopqrstuvwxyz';

    await Promise.all([...word].map((ch) => channel.write(ch)));

    expect(sent.join('')).toBe(word);
  });

  it('coalesces what arrived while a request was in flight', async () => {
    const sent: string[] = [];
    const channel = openInputChannel(racingPost(sent, [30]));

    const first = channel.write('a');
    // Everything typed during that first slow request rides in one follow-up.
    const rest = [...'bcdefghij'].map((ch) => channel.write(ch));
    await Promise.all([first, ...rest]);

    expect(sent).toEqual(['a', 'bcdefghij']);
  });

  it('sends one request per keystroke when the operator types slowly', async () => {
    const sent: string[] = [];
    const channel = openInputChannel(racingPost(sent));
    await channel.write('a');
    await channel.write('b');
    expect(sent).toEqual(['a', 'b']);
  });

  it('tells every caller in a batch what happened to it', async () => {
    const channel = openInputChannel(async () => ({ ok: false, reason: 'the seat is gone' }));
    const results = await Promise.all([channel.write('a'), channel.write('b'), channel.write('c')]);
    expect(results.every((result) => result.ok === false)).toBe(true);
    expect(results[0]?.reason).toBe('the seat is gone');
  });

  it('counts only what is waiting behind the request in flight', async () => {
    const sent: string[] = [];
    const channel = openInputChannel(racingPost(sent, [20]));
    const first = channel.write('hello');
    // The first write leaves immediately, so nothing is waiting for it yet.
    expect(channel.pending).toBe(0);
    const second = channel.write('there');
    expect(channel.pending).toBe(5);
    await Promise.all([first, second]);
    expect(channel.pending).toBe(0);
  });

  it('says nothing at all for an empty write', async () => {
    const sent: string[] = [];
    const channel = openInputChannel(racingPost(sent));
    await channel.write('');
    expect(sent).toEqual([]);
  });

  it('keeps working after a failed batch', async () => {
    const sent: string[] = [];
    let fail = true;
    const channel = openInputChannel(async (payload) => {
      if (fail) {
        fail = false;
        return { ok: false, reason: 'nope' };
      }
      sent.push(payload.keys);
      return { ok: true };
    });
    await channel.write('a');
    await channel.write('b');
    expect(sent).toEqual(['b']);
  });
});
