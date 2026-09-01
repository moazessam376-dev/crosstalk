// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from '../../src/ui/layout/Stream.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

/**
 * Where the operator is left standing.
 *
 * Nothing in the hub restored a scroll position, and that one absence had three
 * faces: a freshly mounted stream sat on the oldest event in the room, room
 * switches carried the previous room's offset over for the browser to clamp,
 * and events arriving over SSE never scrolled at all, so a message could land
 * below the fold in silence.
 *
 * jsdom does no layout, so `scrollHeight` and `clientHeight` are zero for every
 * element. They are stubbed on the prototype here rather than on one node,
 * because the component reads them from a ref this test never touches.
 */

const VIEWPORT = 400;
const CONTENT = 5000;

type Proto = { scrollHeight: unknown; clientHeight: unknown };

function prototypeOf(): Proto {
  return (globalThis as unknown as { window: { HTMLElement: { prototype: Proto } } }).window.HTMLElement.prototype;
}

let saved: [PropertyDescriptor | undefined, PropertyDescriptor | undefined];

beforeEach(() => {
  const proto = prototypeOf() as unknown as object;
  saved = [
    Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  ];
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => CONTENT });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => VIEWPORT });
});

afterEach(() => {
  const proto = prototypeOf() as unknown as object;
  for (const [name, descriptor] of [['scrollHeight', saved[0]], ['clientHeight', saved[1]]] as const) {
    if (descriptor === undefined) delete (proto as Record<string, unknown>)[name];
    else Object.defineProperty(proto, name, descriptor);
  }
  cleanup();
});

function say(seq: number, room: string, body: string): CrosstalkEvent {
  return { kind: 'message', seq, ts: '2026-09-01T00:00:00.000Z', from: 'peer-1', room, body };
}

const FLOOR = [say(1, '#floor', 'first'), say(2, '#floor', 'second'), say(3, '#floor', 'third')];
const SIDE = [say(4, 'dm:peer-1~peer-2', 'a side room message')];

function stream(props: { room: string; events: CrosstalkEvent[]; hidden?: boolean }) {
  return createElement(Stream, {
    events: props.events,
    activeRoom: props.room,
    rooms: [{ id: '#floor', kind: 'floor' }, { id: 'dm:peer-1~peer-2', kind: 'direct' }],
    self: 'peer-1',
    ...(props.hidden === undefined ? {} : { hidden: props.hidden }),
  });
}

function scroller(): { scrollTop: number } {
  return screen.getByTestId('stream-scroll') as unknown as { scrollTop: number };
}

describe('the board’s scroll position', () => {
  it('opens a room at the newest message, not the oldest', () => {
    render(stream({ room: '#floor', events: [...FLOOR, ...SIDE] }));

    expect(scroller().scrollTop).toBe(CONTENT);
  });

  it('puts you back where you were when you return to a room', () => {
    const view = render(stream({ room: '#floor', events: [...FLOOR, ...SIDE] }));
    scroller().scrollTop = 1200;
    fireEvent.scroll(screen.getByTestId('stream-scroll'));

    view.rerender(stream({ room: 'dm:peer-1~peer-2', events: [...FLOOR, ...SIDE] }));
    expect(scroller().scrollTop).toBe(CONTENT);

    view.rerender(stream({ room: '#floor', events: [...FLOOR, ...SIDE] }));
    expect(scroller().scrollTop).toBe(1200);
  });

  it('follows a new message when you are already at the bottom', () => {
    const view = render(stream({ room: '#floor', events: FLOOR }));
    scroller().scrollTop = CONTENT - VIEWPORT;
    fireEvent.scroll(screen.getByTestId('stream-scroll'));

    view.rerender(stream({ room: '#floor', events: [...FLOOR, say(9, '#floor', 'arrived')] }));

    expect(scroller().scrollTop).toBe(CONTENT);
  });

  it('leaves you alone when you have scrolled up to read something', () => {
    // The neighbouring case, and the one that makes the rule worth having. A
    // stream that always jumps to the bottom is as unreadable as one that never
    // does.
    const view = render(stream({ room: '#floor', events: FLOOR }));
    scroller().scrollTop = 900;
    fireEvent.scroll(screen.getByTestId('stream-scroll'));

    view.rerender(stream({ room: '#floor', events: [...FLOOR, say(9, '#floor', 'arrived')] }));

    expect(scroller().scrollTop).toBe(900);
  });

  it('restores the offset after the board has been hidden behind a terminal', () => {
    // A `display: none` element has its scrollTop reset to zero by the browser,
    // so the offset has to be held in a ref rather than read back off the node.
    const view = render(stream({ room: '#floor', events: FLOOR }));
    scroller().scrollTop = 1500;
    fireEvent.scroll(screen.getByTestId('stream-scroll'));

    view.rerender(stream({ room: '#floor', events: FLOOR, hidden: true }));
    scroller().scrollTop = 0;
    view.rerender(stream({ room: '#floor', events: FLOOR, hidden: false }));

    expect(scroller().scrollTop).toBe(1500);
  });
});
