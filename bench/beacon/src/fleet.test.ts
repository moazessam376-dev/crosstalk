import { describe, expect, it } from 'vitest';
import { IllegalMoveError, moveShip, nightFleet } from './fleet.js';

describe('nightFleet', () => {
  it('boots eight inbound ships with distinct ids', () => {
    const fleet = nightFleet();
    expect(fleet).toHaveLength(8);
    expect(new Set(fleet.map((ship) => ship.id)).size).toBe(8);
    expect(fleet.every((ship) => ship.state === 'inbound')).toBe(true);
  });
});

describe('moveShip', () => {
  it('docks an inbound ship', () => {
    const [ship] = nightFleet();
    expect(moveShip(ship!, 'docked').state).toBe('docked');
  });

  it('refuses to move a docked ship with a named error', () => {
    const docked = { ...nightFleet()[0]!, state: 'docked' as const };
    expect(() => moveShip(docked, 'inbound')).toThrowError(IllegalMoveError);
  });

  it('refuses to refloat a wreck', () => {
    const wrecked = { ...nightFleet()[0]!, state: 'wrecked' as const };
    expect(() => moveShip(wrecked, 'holding')).toThrowError(IllegalMoveError);
  });
});
