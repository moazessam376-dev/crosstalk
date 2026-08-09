import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from '../../src/core/projection.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { ClaimVerdict } from '../../src/contracts/claim.js';

async function loadFixture(name: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(join('tests', 'fixtures', `${name}.jsonl`), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrosstalkEvent);
}

describe('project', () => {
  it('is deterministic — same events, same state', async () => {
    const events = await loadFixture('session-dispute');
    expect(JSON.stringify(project(events), replacer))
      .toEqual(JSON.stringify(project(events), replacer));
  });

  it('folds a contested claim to state "contested" with rounds preserved', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118');
    expect(claim?.state).toBe('contested');
    expect(claim?.rounds).toBe(3);
  });

  it('marks evidence stale when an evidence_stale event names its sha', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118')!;
    expect(claim.evidence.some((e) => e.stale === true)).toBe(true);
  });

  it('ignores ts entirely — reordering by ts does not change state', async () => {
    const events = await loadFixture('session-dispute');
    const scrambled = events.map((e, i) => ({ ...e, ts: new Date(2000, 0, events.length - i).toISOString() }));
    expect(JSON.stringify(project(scrambled), replacer))
      .toEqual(JSON.stringify(project(events), replacer));
  });

  it.each([
    ['accept', 'upheld'],
    ['concede', 'withdrawn'],
    ['amend', 'superseded'],
  ] as const)('resolves %s claim responses as %s', (verdict, resolution) => {
    const claim = project(claimResponseEvents(verdict)).claims.get('C-1');
    expect(claim?.state).toBe('resolved');
    expect(claim?.resolution).toBe(resolution);
  });
});

function replacer(_k: string, v: unknown) {
  return v instanceof Map ? Object.fromEntries([...v.entries()].sort()) : v;
}

function claimResponseEvents(verdict: ClaimVerdict): CrosstalkEvent[] {
  return [
    {
      seq: 1,
      ts: '2026-08-09T00:00:00.000Z',
      kind: 'claim_raised',
      from: 'leader',
      claim: {
        id: 'C-1',
        raisedBy: 'leader',
        against: 'codex',
        target: 'src/example.ts:1',
        assertion: 'Example claim',
        severity: 'defect',
        falsifier: 'If wrong, the focused projection test shows a different resolution.',
        evidence: [],
        state: 'open',
        rounds: 0,
      },
    },
    {
      seq: 2,
      ts: '2026-08-09T00:00:01.000Z',
      kind: 'claim_response',
      from: 'codex',
      claimId: 'C-1',
      verdict,
      rationale: 'Focused projection response.',
      falsifier: 'If wrong, this event will not project to the expected terminal resolution.',
      evidence: [],
    },
  ];
}
