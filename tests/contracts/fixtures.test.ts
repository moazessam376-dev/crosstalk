import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const NAMES = ['session-basic', 'session-dispute'] as const;

const KINDS = new Set([
  'participant_joined', 'participant_left', 'message',
  'task_created', 'task_state', 'brief_ack',
  'claim_raised', 'claim_response', 'evidence_added', 'evidence_stale',
  'rebase_notice', 'decision_opened', 'vote_cast', 'decision_resolved',
  'brief_updated',
]);

async function load(name: string): Promise<{ raw: string; events: CrosstalkEvent[] }> {
  const raw = await readFile(join(FIXTURES, `${name}.jsonl`), 'utf8');
  const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrosstalkEvent);
  return { raw, events };
}

describe.each(NAMES)('fixture %s', (name) => {
  it('is LF-only', async () => {
    const { raw } = await load(name);
    expect(raw).not.toContain('\r');
  });

  it('has contiguous seq starting at 1', async () => {
    const { events } = await load(name);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('uses only declared event kinds', async () => {
    const { events } = await load(name);
    for (const e of events) expect(KINDS).toContain(e.kind);
  });
});

// These guard the thesis. If a fixture is ever edited into violating one of
// them, the protocol it is meant to demonstrate has been quietly weakened.
describe('fixtures obey the falsifiability rules', () => {
  it('every raised claim carries a non-trivial falsifier', async () => {
    for (const name of NAMES) {
      const { events } = await load(name);
      for (const e of events) {
        if (e.kind !== 'claim_raised') continue;
        expect(e.claim.falsifier.length).toBeGreaterThan(20);
      }
    }
  });

  it('every contest carries rationale, falsifier and counter-evidence', async () => {
    const { events } = await load('session-dispute');
    const contests = events.filter((e) => e.kind === 'claim_response' && e.verdict === 'contest');
    expect(contests.length).toBeGreaterThan(0);
    for (const e of contests) {
      if (e.kind !== 'claim_response') continue;
      expect(e.rationale?.length ?? 0).toBeGreaterThan(0);
      expect(e.falsifier?.length ?? 0).toBeGreaterThan(20);
      expect(e.evidence.length).toBeGreaterThan(0);
    }
  });

  it('every uphold carries evidence not already on the claim', async () => {
    const { events } = await load('session-dispute');
    const raised = events.find((e) => e.kind === 'claim_raised');
    if (raised?.kind !== 'claim_raised') throw new Error('fixture has no claim_raised');
    const seen = new Set(raised.claim.evidence.map((v) => `${v.sha}::${v.command ?? v.ref ?? ''}`));

    const upholds = events.filter((e) => e.kind === 'claim_response' && e.verdict === 'uphold');
    expect(upholds.length).toBeGreaterThan(0);
    for (const e of upholds) {
      if (e.kind !== 'claim_response') continue;
      const fresh = e.evidence.filter((v) => !seen.has(`${v.sha}::${v.command ?? v.ref ?? ''}`));
      expect(fresh.length).toBeGreaterThan(0);
    }
  });

  it('every vote carries a rationale', async () => {
    const { events } = await load('session-dispute');
    const votes = events.filter((e) => e.kind === 'vote_cast');
    expect(votes.length).toBeGreaterThan(0);
    for (const e of votes) {
      if (e.kind !== 'vote_cast') continue;
      expect(e.rationale.length).toBeGreaterThan(0);
    }
  });
});
