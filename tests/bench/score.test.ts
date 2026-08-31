import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstEditCeremonyTokens, scoreCells, scoreResults, type CellResult } from '../../bench/score.js';

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

  it('counts the builder brief, not JOB.md, as Crosstalk first-edit ceremony', async () => {
    const job = await readFile(join('bench', 'quorum', 'JOB.md'), 'utf8');
    const worker = await readFile(join('src', 'harness', 'templates', 'worker.md'), 'utf8');
    const task = 'T-01 Wire seed\n\nApp() loads API seed.';
    const solo = firstEditCeremonyTokens({ cell: 'solo', jobText: job });
    const github = firstEditCeremonyTokens({
      cell: 'github',
      jobText: job,
      extraBeforeEdit: 'Read JOB.md. Implement here.\n',
    });
    const crosstalk = firstEditCeremonyTokens({ cell: 'crosstalk', jobText: job, extraBeforeEdit: worker + task });
    expect(solo).toBeGreaterThan(0);
    expect(crosstalk).toBeGreaterThan(0);
    expect(crosstalk).toBeLessThan(solo);
    expect(github).toBeGreaterThan(solo);

    const dumped = firstEditCeremonyTokens({ cell: 'crosstalk', jobText: job, extraBeforeEdit: worker + job });
    expect(dumped).toBeGreaterThan(solo);
  });

  it('keeps the declared roster on a cell result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-roster-'));
    const roster = [
      { seat: 'solo', model: 'claude-opus-5-thinking-high', effort: 'high', note: 'closest Task slug to Opus 5 xhigh' },
    ];
    for (const name of ['solo', 'github', 'crosstalk'] as const) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(
        join(root, name, 'result.json'),
        JSON.stringify(cell({ cell: name, roster })),
        'utf8',
      );
    }
    const score = await scoreResults(root);
    expect(score.cells[0]?.roster?.[0]?.model).toBe('claude-opus-5-thinking-high');
    expect(score.cells[0]?.roster?.[0]?.effort).toBe('high');
  });
});
