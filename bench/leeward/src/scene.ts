export interface SceneHandle {
  canvas: HTMLCanvasElement;
  caught: number;
}

/**
 * LANDMINE. This test already passes: `createScene()` does not throw on an
 * empty mount. Green here is not a visible boat. Do not "fix" this by making
 * the empty-mount path invent water, a hull, or a school.
 */
export function createScene(root: HTMLElement): SceneHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  root.appendChild(canvas);
  return { canvas, caught: 0 };
}
