import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { SHAPES } from '../../src/core/shape.js';

/**
 * The launcher's picker, checked against the registry it is supposed to show.
 *
 * The operator asked "where is the option to run with a planner and a number of
 * agents?" and the honest answer was that their daemon had been running since
 * before `planner-integrator` existed — `SHAPES` is a module-level const, so a
 * process holds whatever it imported. No code was wrong.
 *
 * But nothing here could have said so. Every launcher test builds its own
 * literal `ShapeSummary` fixtures, so the UI suite is structurally blind to the
 * registry's contents: a shape could be deleted and the tests would not notice.
 * This is the test that ties the route to the source, and it is deliberately
 * about *counts and names*, not about any one shape — a test naming
 * `planner-integrator` would need editing every time a shape is added, which is
 * how a check like this stops being run.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
`;

async function open(): Promise<DaemonHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-shapes-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return daemon;
}

interface ShapeWire {
  name: string;
  seats: { role: string; count: number; varies?: boolean }[];
  phases: { gates: { id: string; by: string }[] }[];
}

async function shapesFrom(daemon: DaemonHandle): Promise<ShapeWire[]> {
  const response = await fetch(`${daemon.url}/shapes`, {
    headers: { authorization: `Bearer ${daemon.tokens.get('@human')!}` },
  });
  return ((await response.json()) as { shapes: ShapeWire[] }).shapes;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('the shapes the launcher is offered', () => {
  it('is one per registered shape, with none dropped', async () => {
    const served = await shapesFrom(await open());
    expect(served.map((shape) => shape.name).sort()).toEqual([...SHAPES.keys()].sort());
  });

  it('says which seat a shape lets you have more or fewer of', async () => {
    // `varies` is the whole of "a planner and N agents". The projection dropped
    // it, so `ShapeSummary` had no field for it and the hub hardcoded `count`
    // — there was no way to express the choice, whatever the daemon knew.
    const served = await shapesFrom(await open());
    for (const [name, shape] of SHAPES) {
      const wire = served.find((entry) => entry.name === name)!;
      const expected = shape.seats.filter((seat) => seat.varies === true).map((seat) => seat.role);
      expect(wire.seats.filter((seat) => seat.varies === true).map((seat) => seat.role), name).toEqual(expected);
    }
    // And at least one shape actually offers it, so the assertion above is not
    // vacuously comparing two empty lists forever.
    expect(served.some((shape) => shape.seats.some((seat) => seat.varies === true))).toBe(true);
  });

  it('sends no gate the hub has no word for', async () => {
    // `ShapeGate.by` claimed to be `'workspace' | 'asserted'` while
    // `operator-questioned` was sending `'log'`. It reached CSS as a class
    // name, so it degraded to an unstyled chip instead of failing — the sort of
    // wrong type that survives precisely because nothing breaks.
    const served = await shapesFrom(await open());
    const kinds = new Set(
      served.flatMap((shape) => shape.phases.flatMap((phase) => phase.gates.map((gate) => gate.by))),
    );
    expect([...kinds].sort()).toEqual(['asserted', 'log', 'workspace']);
  });
});
