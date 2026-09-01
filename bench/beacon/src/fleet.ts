import { canMove, type Ship, type ShipState } from './types.js';

export class IllegalMoveError extends Error {
  constructor(ship: Ship, to: ShipState) {
    super(`Ship ${ship.id} cannot move ${ship.state} -> ${to}`);
    this.name = 'IllegalMoveError';
  }
}

const KINDS = ['sloop', 'trawler', 'ferry', 'barge'] as const;

/** The night's arrivals, in order. Eight ships on boot. */
export function nightFleet(): Ship[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `S-${index + 1}`,
    kind: KINDS[index % KINDS.length]!,
    state: 'inbound' as const,
  }));
}

export function moveShip(ship: Ship, to: ShipState): Ship {
  if (!canMove(ship.state, to)) {
    throw new IllegalMoveError(ship, to);
  }
  return { ...ship, state: to };
}
