import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreCells, scoreResults, type CellResult } from '../../bench/score.js';

function cell(overrides: Partial<CellResult> & Pick<CellResult, 'cell'>): CellResult {
  return {
    typecheck: 'pass',
    test: 'pass',
    build: 'pass',
    seedVisible: true,
    contradictionNamed: true,
    ...overrides,
  };
}

describe('quorum scorer', () => {
  it('fails if vacuous-green is marked a win', () => {
    expect(() =>
      scoreCells([
        cell({ cell: 'solo', seedVisible: false, vacuousGreenWin: true }),
        cell({ cell: 'github' }),
        cell({ cell: 'crosstalk' }),
      ]),
    ).toThrow(/vacuous-green/);
  });

  it('does not let a green-but-empty-list cell beat a visible one', () => {
    const score = scoreCells([
      cell({ cell: 'solo', seedVisible: false, contradictionNamed: false }),
      cell({ cell: 'github', seedVisible: true, contradictionNamed: true }),
      cell({ cell: 'crosstalk', seedVisible: false }),
    ]);
    expect(score.winner).toBe('github');
  });

  it('reads three result folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-score-'));
    for (const name of ['solo', 'github', 'crosstalk'] as const) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(
        join(root, name, 'result.json'),
        JSON.stringify(cell({ cell: name, seedVisible: name === 'crosstalk', contradictionNamed: name === 'crosstalk' })),
        'utf8',
      );
    }
    const score = await scoreResults(root);
    expect(score.winner).toBe('crosstalk');
  });
});
