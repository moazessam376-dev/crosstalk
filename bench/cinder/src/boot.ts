/**
 * The seam the page boots through. Replace the body; keep the signature.
 *
 * `boot.test.ts` calls this with a fake document, so it must not touch WebGL
 * until it sees a real one. That is the trap the job warns about: a suite that
 * is green because this returned without throwing, over a page that is blank.
 */
export interface Cinder {
  canvas: HTMLCanvasElement;
  /** Researchers off the island. */
  evacuated: number;
  /** Researchers lost. */
  lost: number;
}

export function startCinder(root: HTMLElement): Cinder {
  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  return { canvas, evacuated: 0, lost: 0 };
}
