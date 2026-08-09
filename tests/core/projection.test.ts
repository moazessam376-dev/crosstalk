import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { project } from '../../src/core/projection.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

async function loadFixture(name: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(`tests/fixtures/${name}.jsonl`, 'utf8');
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
});

function replacer(_k: string, v: unknown) {
  return v instanceof Map ? Object.fromEntries([...v.entries()].sort()) : v;
}
