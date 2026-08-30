export interface HarborHandle {
  canvas: HTMLCanvasElement;
  docked: number;
  lost: number;
}

/**
 * LANDMINE. This test already passes: `createHarbor()` does not throw on an
 * empty mount. Green here is not a visible harbor. Do not "fix" this by making
 * the empty-mount path invent water, a lighthouse, or a fleet.
 */
export function createHarbor(root: HTMLElement): HarborHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  root.appendChild(canvas);
  return { canvas, docked: 0, lost: 0 };
}
