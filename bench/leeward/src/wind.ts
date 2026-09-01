import type { Wind } from './types.js';

export const TRADE: Wind = {
  heading: 240,
  knots: 12,
};

export function push(wind: Wind, heading: number, dt: number): { x: number; z: number } {
  const rad = (wind.heading * Math.PI) / 180;
  const force = wind.knots * 0.02 * dt;
  return {
    x: Math.cos(rad) * force,
    z: Math.sin(rad) * force,
  };
}

export function veer(wind: Wind, heading: number): Wind {
  return { heading, knots: wind.knots };
}
