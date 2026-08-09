import { useEffect, useState } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';

export type LogSource =
  | { kind: 'fixture'; path: string }
  | { kind: 'sse'; url: string };

export interface UseLogResult {
  events: CrosstalkEvent[];
  connected: boolean;
}

function sortBySequence(events: CrosstalkEvent[]): CrosstalkEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq);
}

function parseEvents(text: string): CrosstalkEvent[] {
  const events = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CrosstalkEvent);
  return sortBySequence(events);
}

export function useLog(source: LogSource): UseLogResult {
  const [events, setEvents] = useState<CrosstalkEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceKey = source.kind === 'fixture' ? `fixture:${source.path}` : `sse:${source.url}`;

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setConnected(false);

    if (source.kind === 'fixture') {
      void fetch(source.path)
        .then((response) => {
          if (!response.ok) throw new Error(`Unable to load fixture: ${response.status}`);
          return response.text();
        })
        .then((text) => {
          if (cancelled) return;
          setEvents(parseEvents(text));
          setConnected(true);
        })
        .catch(() => {
          if (!cancelled) setConnected(false);
        });

      return () => {
        cancelled = true;
      };
    }

    const stream = new EventSource(source.url);
    stream.onopen = () => {
      if (!cancelled) setConnected(true);
    };
    stream.onmessage = (message) => {
      if (cancelled) return;
      try {
        const event = JSON.parse(message.data) as CrosstalkEvent;
        setEvents((current) => sortBySequence([...current, event]));
      } catch {
        // A malformed stream item must not tear down the live subscription.
      }
    };
    stream.onerror = () => {
      if (!cancelled) setConnected(false);
    };

    return () => {
      cancelled = true;
      stream.close();
    };
  }, [sourceKey]);

  return { events, connected };
}
