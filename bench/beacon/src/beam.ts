import type { Beam } from './types.js';

export function restingBeam(): Beam {
  return { bearing: 0, spread: Math.PI / 10 };
}

/** Advance an unattended beam: a slow steady sweep. */
export function sweep(beam: Beam, dtSeconds: number): Beam {
  const full = Math.PI * 2;
  return { ...beam, bearing: (beam.bearing + dtSeconds * 0.4 + full) % full };
}

/** Whether a bearing (radians) falls inside the lit arc. */
export function lit(beam: Beam, bearing: number): boolean {
  const full = Math.PI * 2;
  const delta = Math.abs(((bearing - beam.bearing + Math.PI) % full) - Math.PI);
  return delta <= beam.spread / 2;
}
