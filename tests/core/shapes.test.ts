import { describe, expect, it } from 'vitest';
import { SHAPES, type TeamShape } from '../../src/core/shape.js';
import { MESSAGE_TAGS } from '../../src/contracts/say.js';
import { WORKSPACE_GATES } from '../../src/workspace/gates.js';
import { LOG_GATES } from '../../src/core/phase.js';

const shapes: [string, TeamShape][] = [...SHAPES.entries()];

/**
 * What a shape may not get wrong.
 *
 * `trio-contract` shipped a `contract-exists` gate that read
 * `config.contractPath`, which nothing has ever written — not `init`, not
 * `POST /launch`, and there is no flag. `phaseStatus` returns the first phase
 * with an unmet gate, so every seat's inbox read `plan: contract-exists — no
 * contract path is configured` with `writes: no-source` for the entire
 * fourteen-hour vault-team run. They built anyway, which is the right call and
 * also the end of that field meaning anything.
 *
 * Nothing caught it because a shape is data and nobody checked the data against
 * the code that reads it. That is what this file is.
 */
describe('every registered shape', () => {
  it('has at least one, so these assertions are about something', () => {
    expect(shapes.length).toBeGreaterThan(0);
  });

  for (const [name, shape] of shapes) {
    describe(name, () => {
      const gates = shape.phases.flatMap((phase) => phase.exit);

      it('names only workspace gates that are actually implemented', () => {
        const asked = gates.filter((gate) => gate.by === 'workspace').map((gate) => gate.id);
        for (const id of asked) expect(WORKSPACE_GATES).toContain(id);
      });

      it('names only log gates that are actually derived', () => {
        const asked = gates.filter((gate) => gate.by === 'log').map((gate) => gate.id);
        for (const id of asked) expect(LOG_GATES).toContain(id);
      });

      it('owns every phase with a role it actually staffs', () => {
        const staffed = shape.seats.map((seat) => seat.role);
        for (const phase of shape.phases) {
          if (phase.owner === undefined) continue;
          expect(staffed, `${name} gives ${phase.id} to an unstaffed ${phase.owner}`).toContain(phase.owner);
        }
      });

      it('can actually finish every seat', () => {
        // A seat whose `done` gate appears in no phase can never be finished,
        // and nothing would say so.
        const exits = new Set(gates.map((gate) => gate.id));
        for (const seat of shape.seats) {
          if (seat.done === undefined) continue;
          expect([...exits], `${name}: ${seat.role} is done on a gate no phase asks for`).toContain(seat.done);
        }
      });

      it('gives every seat only real tags', () => {
        for (const seat of shape.seats) {
          for (const tag of seat.tags ?? []) expect(MESSAGE_TAGS).toContain(tag);
        }
      });

      it('supplies a contract path when it gates on one', () => {
        // A shape that asks for `contract-exists` and names no contract is
        // asking a question with no answer, and the phase machine stalls on it
        // forever rather than failing loudly.
        const needsContract = gates.some((gate) => gate.id === 'contract-exists');
        if (!needsContract) return;
        expect(shape.contract, `${name} gates on contract-exists but names no contract`).toBeTruthy();
      });

      it('ends on a phase, and every phase can be left', () => {
        expect(shape.phases.length).toBeGreaterThan(0);
        for (const phase of shape.phases) expect(phase.exit.length).toBeGreaterThan(0);
      });

      it('staffs every seat it describes', () => {
        expect(shape.seats.length).toBeGreaterThan(0);
        for (const seat of shape.seats) expect(seat.count).toBeGreaterThan(0);
      });
    });
  }
});
