import { describe, expect, it } from 'vitest';
import { SHAPES, type TeamShape } from '../../src/core/shape.js';
import { WORKSPACE_GATES } from '../../src/workspace/gates.js';

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
