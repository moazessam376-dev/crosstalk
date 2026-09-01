// @vitest-environment jsdom

import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLog } from '../../src/ui/state/useLog.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { runMarker } from '../../src/core/runs.js';

/**
 * A hub that is already connected when a run starts.
 *
 * Clamping the daemon's read paths fixes a *fresh* page load and nothing else:
 * the socket stays open across a launch, so a hub that was watching keeps every
 * event it has already accumulated. The stale rooms the operator complained
 * about are derived from that buffer — `projectRooms` builds the sidebar from
 * whatever events it holds — so the previous run's `dm:` rooms survive a launch
 * that was supposed to clear the board.
 *
 * The fix belongs here rather than in `projectRooms`: the buffer is the thing
 * that is wrong, and every other projection reads from it too.
 */

/** A minimal EventSource that lets a test push frames. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  emit(event: CrosstalkEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close(): void {
    this.closed = true;
  }
}

function message(seq: number, body: string): CrosstalkEvent {
  return {
    kind: 'message',
    seq,
    ts: new Date(Date.UTC(2026, 8, 2, 12, 0, seq)).toISOString(),
    room: '#floor',
    from: 'peer-1',
    body,
  } as CrosstalkEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.last = undefined;
});

describe('a connected hub when a run begins', () => {
  it('drops what it is holding rather than appending to it', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { result } = renderHook(() => useLog({ kind: 'sse', url: '/stream' }));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const stream = FakeEventSource.last!;

    act(() => {
      stream.onopen?.();
      stream.emit(message(1, 'the previous run said this'));
      stream.emit(message(2, 'at length'));
    });
    expect(result.current.events).toHaveLength(2);

    act(() => {
      stream.emit({ ...runMarker('r-20260902-1412-a3f1c9'), seq: 3, ts: '' } as CrosstalkEvent);
    });

    // The marker is kept: it is this run's first event, and the projection
    // needs a floor to build from. Everything before it is gone.
    expect(result.current.events).toHaveLength(1);
    expect(JSON.stringify(result.current.events)).not.toContain('the previous run said this');

    act(() => {
      stream.emit(message(4, 'and this run says that'));
    });
    expect(JSON.stringify(result.current.events)).toContain('and this run says that');
    expect(JSON.stringify(result.current.events)).not.toContain('at length');
  });

  it('keeps accumulating normally when no run starts', async () => {
    // The neighbouring case. A reset triggered by the wrong frame would empty
    // the board on an ordinary message, which is a worse bug than the one
    // being fixed.
    vi.stubGlobal('EventSource', FakeEventSource);
    const { result } = renderHook(() => useLog({ kind: 'sse', url: '/stream' }));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const stream = FakeEventSource.last!;

    act(() => {
      stream.onopen?.();
      stream.emit(message(1, 'one'));
      stream.emit(message(2, 'two'));
      // A seat quoting a run ref is not the daemon starting a run.
      stream.emit({ ...message(3, 'three'), ref: 'run:r-20260902-1412-a3f1c9' } as CrosstalkEvent);
    });

    expect(result.current.events).toHaveLength(3);
  });
});
