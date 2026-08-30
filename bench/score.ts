import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Cell = 'solo' | 'github' | 'crosstalk';

export interface CellResult {
  cell: Cell;
  typecheck: 'pass' | 'fail';
  test: 'pass' | 'fail';
  build: 'pass' | 'fail';
  /** Did a human look and see the seeded list? Vacuous-green is not this. */
  seedVisible: boolean;
  contradictionNamed: boolean;
  /**
   * True when the cell claims a win because tests are green and the seed
   * list is not visible. The scorer must fail that.
   */
  vacuousGreenWin?: boolean;
  wallClockSeconds?: number;
  blockedWaitSeconds?: number;
  ceremonyTokensBeforeFirstEdit?: number;
  operatorMinutes?: number;
  lookNote?: string;
}

export interface Score {
  winner: Cell | 'none';
  reason: string;
  cells: CellResult[];
}

function artifactOk(cell: CellResult): boolean {
  return cell.typecheck === 'pass' && cell.test === 'pass' && cell.build === 'pass' && cell.seedVisible;
}

export function scoreCells(cells: CellResult[]): Score {
  for (const cell of cells) {
    if (cell.vacuousGreenWin === true) {
      throw new Error(`${cell.cell} marked vacuous-green as a win — that is not a win`);
    }
  }

  const shipped = cells.filter(artifactOk);
  if (shipped.length === 0) {
    return { winner: 'none', reason: 'no cell shipped a visible seed list', cells };
  }

  const named = shipped.filter((cell) => cell.contradictionNamed);
  const pool = named.length > 0 ? named : shipped;
  const ranked = [...pool].sort((left, right) => {
    const wait = (left.blockedWaitSeconds ?? Number.POSITIVE_INFINITY) - (right.blockedWaitSeconds ?? Number.POSITIVE_INFINITY);
    if (wait !== 0) return wait;
    const ceremony = (left.ceremonyTokensBeforeFirstEdit ?? Number.POSITIVE_INFINITY) - (right.ceremonyTokensBeforeFirstEdit ?? Number.POSITIVE_INFINITY);
    if (ceremony !== 0) return ceremony;
    return (left.operatorMinutes ?? Number.POSITIVE_INFINITY) - (right.operatorMinutes ?? Number.POSITIVE_INFINITY);
  });

  return { winner: ranked[0]!.cell, reason: named.length > 0 ? 'artifact plus named contradiction' : 'artifact only', cells };
}

export async function readCell(dir: string, cell: Cell): Promise<CellResult> {
  const raw = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as CellResult;
  return { ...raw, cell };
}

export async function scoreResults(root: string): Promise<Score> {
  const cells = await Promise.all(
    (['solo', 'github', 'crosstalk'] as const).map((cell) => readCell(join(root, cell), cell)),
  );
  return scoreCells(cells);
}

/** chars/4. Handmade 450/700/900 constants are how loops 1–4 hid the real intake. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Tokens the first code editor must read.
 * Solo and GitHub read `jobText`. Crosstalk's first editor is the builder:
 * pass their brief + task job as `extraBeforeEdit`, not the floor novel.
 */
export function firstEditCeremonyTokens(args: {
  cell: Cell;
  jobText: string;
  extraBeforeEdit?: string;
}): number {
  const extra = args.extraBeforeEdit ?? '';
  if (args.cell === 'crosstalk') return estimateTokens(extra);
  return estimateTokens(`${args.jobText}${extra}`);
}
