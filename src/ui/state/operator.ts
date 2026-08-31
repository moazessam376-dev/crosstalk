import { useCallback, useEffect, useState } from 'react';

/**
 * What to call the person using the hub.
 *
 * The log records the human seat as `@human` and always will: it is an id, it
 * is in the protocol, and every existing log carries it. What it is not is a
 * name. Crosstalk is going open source, and `@human` on screen reads as a
 * placeholder nobody filled in — which is what it is.
 *
 * So the name is a *display* concern and lives only in the browser. Nothing is
 * written to the log, no contract moves, and a log copied between machines does
 * not carry one person's name into another person's hub. The seat is still
 * `@human` everywhere it matters; it is drawn with a name.
 */
const STORAGE_KEY = 'crosstalk.operator.name';

/** Storage is not always there — a private window, a browser with site data off. */
function storage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined {
  try {
    const local = (globalThis as { localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } })
      .localStorage;
    if (local === undefined) return undefined;
    // Touching it is the test: Safari's "block all cookies" throws on access
    // rather than returning undefined.
    local.getItem(STORAGE_KEY);
    return local;
  } catch {
    return undefined;
  }
}

export function readOperatorName(): string | undefined {
  const value = storage()?.getItem(STORAGE_KEY) ?? undefined;
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/**
 * How a participant id is drawn.
 *
 * Only the operator's own seat is renamed, and only when they have given a
 * name. An agent's id is its id — it is how the team addresses it on the floor,
 * so renaming one in the hub would make the screen disagree with the
 * conversation on it.
 */
export function displayNameFor(id: string, self: string | undefined, operator: string | undefined): string {
  if (operator === undefined) return id;
  return id === (self ?? '@human') ? operator : id;
}

export interface OperatorName {
  /** The name, or `undefined` while it has never been set. */
  name?: string;
  setName(next: string): void;
}

export function useOperatorName(): OperatorName {
  const [name, setStored] = useState<string | undefined>(() => readOperatorName());

  // Read again after mount. The initialiser runs during render, which is also
  // where a server-side or test render has no storage at all; re-reading makes
  // the hook correct in both without making the first paint wait.
  useEffect(() => {
    const found = readOperatorName();
    if (found !== undefined) setStored(found);
  }, []);

  const setName = useCallback((next: string): void => {
    const trimmed = next.trim();
    setStored(trimmed === '' ? undefined : trimmed);
    try {
      storage()?.setItem(STORAGE_KEY, trimmed);
    } catch {
      // A name that cannot be remembered is still a name for this session.
      // Failing the edit would be worse than forgetting it on reload.
    }
  }, []);

  return name === undefined ? { setName } : { name, setName };
}
