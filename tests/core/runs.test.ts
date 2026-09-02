import { describe, expect, it } from 'vitest';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { FLOOR, SYSTEM_ID } from '../../src/contracts/room.js';
import { gateOfRef } from '../../src/core/shape.js';
import {
  RUN_ID_PATTERN,
  isRunStart,
  newRunId,
  runIdOfRef,
  runMarker,
  runRef,
} from '../../src/core/runs.js';

/**
 * A run is a range of the log, and its boundary is a message.
 *
 * The operator opened the hub and read a bench run from the day before: one
 * flat `events.jsonl` per repository, 1187 events, replayed from seq 1 on every
 * page load. There was no run, session or reset concept anywhere in the code.
 *
 * The boundary is a `message` carrying `ref: run:<id>` rather than a new event
 * kind, because CONTEXT.md forbids new kinds and `gate:<id>` already
 * established `ref` as a namespaced scheme. What is pinned here is the part
 * that would be a security bug rather than a display one: a run id reaches
 * `join()` when an archive is read back, so it is validated as an id before it
 * is ever treated as a path.
 */

function message(over: Partial<CrosstalkEvent> & { from: string }): CrosstalkEvent {
  return {
    kind: 'message',
    seq: 1,
    ts: '2026-09-02T12:00:00.000Z',
    room: FLOOR,
    body: 'x',
    ...over,
  } as CrosstalkEvent;
}

describe('naming a run', () => {
  it('mints an id that sorts by time and does not collide', () => {
    // Local, not UTC, and deliberately so: the id is stamped in local time so
    // the picker's "today 14:12" matches when the operator actually started it.
    // Constructing it the same way keeps this true in any CI timezone.
    const at = new Date(2026, 8, 2, 14, 12, 0);
    const first = newRunId(at);
    const second = newRunId(at);

    expect(first).toMatch(RUN_ID_PATTERN);
    expect(second).toMatch(RUN_ID_PATTERN);
    // Same minute, different run: the suffix is what keeps two launches inside
    // one minute from addressing the same archive file.
    expect(first).not.toBe(second);
    expect(first.startsWith('r-20260902-1412-')).toBe(true);
  });

  it('refuses every id that would escape the archive directory', () => {
    // This is the whole reason the pattern exists. `.crosstalk/runs/<id>.jsonl`
    // is built with `join`, and an id is the one part of that path a client
    // chooses — `GET /runs/:id/events` takes it straight off the URL.
    for (const hostile of [
      '../../package.json',
      '..',
      'r-20260902-1412-a3f1c9/../../etc/passwd',
      'r-20260902-1412-a3f1c9.jsonl',
      'R-20260902-1412-A3F1C9',
      'r-2026090-1412-a3f1c9',
      'r-20260902-1412-a3f1c',
      'r-20260902-1412-a3f1c9x',
      '',
    ]) {
      expect(RUN_ID_PATTERN.test(hostile), hostile).toBe(false);
    }
    expect(RUN_ID_PATTERN.test('r-20260902-1412-a3f1c9')).toBe(true);
  });
});

describe('the run marker', () => {
  it('reads its id back off the ref', () => {
    const id = newRunId(new Date());
    expect(runIdOfRef(runRef(id))).toBe(id);
  });

  it('is not confused with a gate assertion, in either direction', () => {
    // Both schemes live on `ref`. If either read the other's, a run boundary
    // would satisfy a phase gate or a gate assertion would end the run.
    expect(gateOfRef(runRef('r-20260902-1412-a3f1c9'))).toBeUndefined();
    expect(runIdOfRef('gate:contract-exists')).toBeUndefined();
    expect(runIdOfRef(undefined)).toBeUndefined();
    expect(runIdOfRef('run:')).toBeUndefined();
    // A malformed id on the wire is not a run, however much it looks like one.
    expect(runIdOfRef('run:../../etc/passwd')).toBeUndefined();
  });

  it('is authored by the daemon, on the floor', () => {
    // `#floor` and not a `run:` room: `parseRoom` throws on an unknown prefix,
    // and the sidebar would file a new prefix under DIRECT.
    const marker = runMarker('r-20260902-1412-a3f1c9');
    expect(marker.from).toBe(SYSTEM_ID);
    expect(marker.room).toBe(FLOOR);
    expect(marker.kind).toBe('message');
  });

  it('recognises its own marker and nothing else', () => {
    expect(isRunStart(message({ from: SYSTEM_ID, ref: runRef('r-20260902-1412-a3f1c9') }))).toBe(true);
    expect(isRunStart(message({ from: SYSTEM_ID, ref: 'gate:contract-exists' }))).toBe(false);
    expect(isRunStart(message({ from: 'peer-1' }))).toBe(false);
    // A seat that writes `ref: run:...` by hand is not allowed to end the run.
    expect(isRunStart(message({ from: 'peer-1', ref: runRef('r-20260902-1412-a3f1c9') }))).toBe(false);
    expect(isRunStart({ kind: 'participant_joined', seq: 2, ts: '', from: 'peer-1' } as CrosstalkEvent)).toBe(false);
  });
});
