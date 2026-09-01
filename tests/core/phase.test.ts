import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { assertedGates, phaseStatus } from '../../src/core/phase.js';
import { SHAPES, gateRef, type GateId } from '../../src/core/shape.js';

const TRIO = SHAPES.get('trio-contract')!;
const SEATS = ['opus', 'sonnet', 'luna'];

function asserts(seq: number, from: string, gate: GateId, body = 'taking the sim'): CrosstalkEvent {
  return {
    kind: 'message',
    seq,
    ts: '2026-08-31T00:00:00.000Z',
    from,
    room: '#floor',
    body,
    ref: gateRef(gate),
  };
}

function chatter(seq: number, from: string): CrosstalkEvent {
  return { kind: 'message', seq, ts: '2026-08-31T00:00:00.000Z', from, room: '#floor', body: 'status?' };
}

const met = new Map([
  ['contract-exists' as GateId, { met: true }],
  ['no-shared-files' as GateId, { met: true }],
]);

describe('assertedGates', () => {
  it('reads a gate off the ref, and ignores ordinary talk', () => {
    const found = assertedGates([chatter(1, 'luna'), asserts(2, 'opus', 'split-agreed')]);

    expect([...found.get('split-agreed')!]).toEqual(['opus']);
    expect(found.has('tests-green')).toBe(false);
  });
});

describe('where the team is', () => {
  it('starts in plan, and says the contract is what is missing', () => {
    const status = phaseStatus(TRIO, {
      events: [],
      participants: SEATS,
      workspace: new Map([['contract-exists' as GateId, { met: false, missing: 'src/contract.ts does not exist yet' }]]),
    });

    expect(status.id).toBe('plan');
    expect(status.blocking.join(' ')).toContain('does not exist');
  });

  it('says a workspace gate is unchecked rather than claiming it failed', () => {
    const status = phaseStatus(TRIO, { events: [], participants: SEATS });
    expect(status.blocking.join(' ')).toContain('not checked yet');
  });

  it('names the seats it is still waiting on, rather than just refusing', () => {
    const status = phaseStatus(TRIO, {
      events: [asserts(1, 'opus', 'split-agreed')],
      participants: SEATS,
      workspace: met,
    });

    // The point of naming them: beacon-1's board filled with "status?" because
    // nothing told a seat who it was waiting for.
    expect(status.id).toBe('plan');
    expect(status.blocking.join(' ')).toContain('sonnet');
    expect(status.blocking.join(' ')).toContain('luna');
  });

  it('advances to build once every seat has posted its split', () => {
    const status = phaseStatus(TRIO, {
      events: SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
      participants: SEATS,
      workspace: met,
    });

    expect(status.id).toBe('build');
    expect(status.writes).toBe('own-files');
  });

  it('holds at build while two seats have written the same file', () => {
    const status = phaseStatus(TRIO, {
      events: [
        ...SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
        ...SEATS.map((seat, i) => asserts(i + 10, seat, 'tests-green')),
      ],
      participants: SEATS,
      workspace: new Map([
        ['contract-exists' as GateId, { met: true }],
        ['no-shared-files' as GateId, { met: false, missing: 'two seats wrote the same file: src/fleet.ts (opus and sonnet)' }],
      ]),
    });

    // The beacon-1 seam bug, refused at the gate instead of shipped.
    expect(status.id).toBe('build');
    expect(status.blocking.join(' ')).toContain('src/fleet.ts');
  });

  it('holds at build until every seat has verified its own work first-hand', () => {
    // The vault-1 lesson as a gate: a green suite is not a delivery. Every seat
    // has posted tests-green here, and build still will not open.
    const status = phaseStatus(TRIO, {
      events: [
        ...SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
        ...SEATS.map((seat, i) => asserts(i + 10, seat, 'tests-green')),
      ],
      participants: SEATS,
      workspace: met,
    });

    expect(status.id).toBe('build');
    expect(status.blocking.join(' ')).toContain('self-verified');
  });

  it('names the seat that has not verified its own surface yet', () => {
    const status = phaseStatus(TRIO, {
      events: [
        ...SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
        ...SEATS.map((seat, i) => asserts(i + 10, seat, 'tests-green')),
        asserts(20, 'opus', 'self-verified', 'played it at four sizes'),
        asserts(21, 'sonnet', 'self-verified', 'ticked the sim and read the log'),
      ],
      participants: SEATS,
      workspace: met,
    });

    expect(status.id).toBe('build');
    expect(status.blocking.join(' ')).toContain('luna');
  });

  const built = [
    ...SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
    ...SEATS.map((seat, i) => asserts(i + 10, seat, 'tests-green')),
    ...SEATS.map((seat, i) => asserts(i + 20, seat, 'self-verified')),
  ];

  it('takes one seat to open verify, not all three', () => {
    const status = phaseStatus(TRIO, { events: built, participants: SEATS, workspace: met });

    expect(status.id).toBe('verify');
    expect(status.writes).toBe('tests-only');
    expect(status.blocking.join(' ')).toContain('nobody has posted it');
  });

  it('will not complete on a clean run alone — the assembled build has to be verified too', () => {
    const status = phaseStatus(TRIO, {
      events: [
        ...built,
        asserts(30, 'opus', 'bug-list-posted', 'three bugs, listed'),
        asserts(31, 'opus', 'run-clean', 'full run clean'),
      ],
      participants: SEATS,
      workspace: met,
    });

    // Each seat verified its own branch; nobody has yet looked at the thing
    // they add up to. That is where vault-1's elevator bug lived.
    expect(status.complete).toBe(false);
    expect(status.blocking.join(' ')).toContain('integration-verified');
  });

  it('reports complete only when every gate is met', () => {
    const status = phaseStatus(TRIO, {
      events: [
        ...built,
        asserts(30, 'opus', 'bug-list-posted', 'three bugs, listed'),
        asserts(31, 'opus', 'run-clean', 'full run clean'),
        asserts(32, 'opus', 'integration-verified', 'played the merged build at four sizes'),
      ],
      participants: SEATS,
      workspace: met,
    });

    expect(status.complete).toBe(true);
    expect(status.blocking).toEqual([]);
  });

  it('goes back when a gate stops being true', () => {
    const events = SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed'));
    const before = phaseStatus(TRIO, { events, participants: SEATS, workspace: met });
    expect(before.id).toBe('build');

    // A merge that undoes the split is a real event, and the phase is derived
    // rather than stored precisely so it can retreat.
    const after = phaseStatus(TRIO, {
      events,
      participants: SEATS,
      workspace: new Map([
        ['contract-exists' as GateId, { met: false, missing: 'src/contract.ts does not exist yet' }],
        ['no-shared-files' as GateId, { met: true }],
      ]),
    });
    expect(after.id).toBe('plan');
  });

  it('ignores the operator when counting who still has to agree', () => {
    const status = phaseStatus(TRIO, {
      events: SEATS.map((seat, i) => asserts(i + 1, seat, 'split-agreed')),
      participants: [...SEATS, '@human'],
      workspace: met,
    });

    expect(status.id).toBe('build');
  });
});

describe('the solo shape', () => {
  it('has no plan phase to gate — there is nobody to agree with', () => {
    const solo = SHAPES.get('solo')!;
    expect(solo.phases.map((phase) => phase.id)).toEqual(['build', 'verify']);
    expect(phaseStatus(solo, { events: [], participants: ['builder'] }).id).toBe('build');
  });
});
