// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLog } from '../../src/ui/state/useLog.js';

describe('useLog', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          [
            '{"seq":2,"ts":"2026-08-09T11:00:02.000Z","kind":"message","from":"codex","room":"#floor","body":"two"}',
            '{"seq":1,"ts":"2026-08-09T11:00:01.000Z","kind":"message","from":"leader","room":"#floor","body":"one"}',
          ].join('\n'),
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a fixture log into ordered events', async () => {
    const { result } = renderHook(() => useLog({ kind: 'fixture', path: '/fixtures/session-dispute.jsonl' }));
    await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));
    const seqs = result.current.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('appends live SSE events and closes the stream on unmount', async () => {
    let source: FakeEventSource | undefined;

    class FakeEventSource {
      readonly url: string;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      readonly close = vi.fn();

      constructor(url: string) {
        this.url = url;
        source = this;
      }

      emitOpen() {
        this.onopen?.();
      }

      emit(data: string) {
        this.onmessage?.({ data } as MessageEvent);
      }
    }

    vi.stubGlobal('EventSource', FakeEventSource);
    const { result, unmount } = renderHook(() => useLog({ kind: 'sse', url: 'http://localhost:4310/stream' }));

    await waitFor(() => expect(source).toBeDefined());
    source?.emitOpen();
    await waitFor(() => expect(result.current.connected).toBe(true));
    source?.emit(
      '{"seq":3,"ts":"2026-08-09T11:00:03.000Z","kind":"message","from":"codex","room":"#floor","body":"three"}',
    );
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([3]));

    unmount();
    expect(source?.close).toHaveBeenCalledTimes(1);
  });
});
