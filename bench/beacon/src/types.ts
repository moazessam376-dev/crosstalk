export type ShipState = 'inbound' | 'holding' | 'docked' | 'wrecked';

export interface Ship {
  id: string;
  kind: string;
  state: ShipState;
}

export interface Beam {
  /** Radians, 0 pointing east, counter-clockwise positive. */
  bearing: number;
  /** Radians of arc the light covers. */
  spread: number;
}

export const SHIP_TRANSITIONS: Record<ShipState, readonly ShipState[]> = {
  inbound: ['holding', 'docked', 'wrecked'],
  holding: ['inbound', 'docked', 'wrecked'],
  docked: [],
  wrecked: [],
};

export function canMove(from: ShipState, to: ShipState): boolean {
  return SHIP_TRANSITIONS[from].includes(to);
}
