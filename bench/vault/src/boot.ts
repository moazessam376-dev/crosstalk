/**
 * The seam the page boots through. Replace the body; keep the signature.
 *
 * `boot.test.ts` calls this with a fake document, so it must not touch WebGL
 * until it sees a real one. That is the trap the job warns about: a suite that
 * is green because this returned without throwing, over a page that is blank.
 */
export interface Vault {
  canvas: HTMLCanvasElement;
  /** Dwellers living in the vault. */
  dwellers: number;
  /** Bottle caps on hand. */
  caps: number;
}

export function startVault(root: HTMLElement): Vault {
  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  return { canvas, dwellers: 0, caps: 0 };
}
