import { describe, it, expect } from 'vitest';
import { TOOLS, TOOLS_BY_NAME } from '../../src/mcp/tools.js';

/**
 * The tool descriptions are the product, so they are asserted like one.
 *
 * Crosstalk's thesis is that falsifiability has to be structural rather than a
 * prompt rule, because prompt rules are forgotten around turn 40 and schemas
 * are not. These tests are where that claim is checked: if `falsifier` stops
 * being required, or `uphold` stops explaining that it needs new evidence, the
 * protocol has quietly become advisory again and nothing else would notice.
 */
function tool(name: string) {
  const found = TOOLS_BY_NAME.get(name);
  if (found === undefined) throw new Error(`No tool named ${name}`);
  return found;
}

function property(name: string, key: string): { description?: string; enum?: string[] } {
  return (tool(name).inputSchema.properties[key] ?? {}) as { description?: string; enum?: string[] };
}

describe('the tools an agent sees', () => {
  it('covers every route the brief names', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'ack_task',
        'add_evidence',
        'await_turn',
        'board',
        'create_task',
        'my_tasks',
        'open_decision',
        'raise_claim',
        'read_events',
        'respond_to_claim',
        'roster',
        'say',
        'set_task_state',
        'submit_task',
        'vote',
      ].sort(),
    );
  });

  it('gives every tool a description long enough to teach something', () => {
    for (const t of TOOLS) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('falsifiability is in the schema, not in a prompt', () => {
  it('makes falsifier a required parameter on raise_claim', () => {
    expect(tool('raise_claim').inputSchema.required).toContain('falsifier');
  });

  it('tells the agent what a falsifier is and what a rejected one looks like', () => {
    const description = property('raise_claim', 'falsifier').description ?? '';

    // Not merely "the falsifier". An agent reading only this should be able to
    // write a good one and recognise a bad one.
    expect(description).toMatch(/wrong/i);
    expect(description).toMatch(/MISSING_FALSIFIER/);
    expect(description).toMatch(/VACUOUS_FALSIFIER/);
    expect(description.toLowerCase()).toContain('bad');
    expect(description.length).toBeGreaterThan(200);
  });

  it('says a claim is not an instruction, so a worker knows contesting is allowed', () => {
    const description = tool('raise_claim').description;
    expect(description).toMatch(/not an instruction/i);
    expect(description).toMatch(/contest/i);
  });

  it('explains in respond_to_claim that uphold needs new evidence and not a falsifier', () => {
    const description = tool('respond_to_claim').description;

    expect(description).toMatch(/uphold/);
    expect(description).toMatch(/NEW EVIDENCE|new evidence/);
    expect(description).toContain('UPHOLD_WITHOUT_NEW_EVIDENCE');
    // The distinction the leader had to correct in AGENTS.md: uphold restates a
    // claim whose falsifier is already on the record; amend is the verdict for a
    // changed argument and does require one.
    expect(description).toMatch(/already on the record/i);
    expect(property('respond_to_claim', 'falsifier').description ?? '').toMatch(/not required for uphold/i);
  });

  it('lists every verdict, so an agent does not have to guess the vocabulary', () => {
    expect(property('respond_to_claim', 'verdict').enum).toEqual([
      'accept',
      'contest',
      'clarify',
      'concede',
      'amend',
      'uphold',
    ]);
  });

  it('says evidence carries a sha and that a rebase makes it stale', () => {
    const description = (
      (tool('raise_claim').inputSchema.properties['evidence'] as { items?: { properties?: Record<string, { description?: string }> } })
        .items?.properties?.['sha']?.description ?? ''
    );
    expect(description).toMatch(/stale/i);
    expect(description).toMatch(/re-?run/i);
  });
});

describe('await_turn is described as the alternative to polling', () => {
  it('tells the agent not to invent a loop or a scheduled task', () => {
    const description = tool('await_turn').description;

    expect(description).toMatch(/do not|don't/i);
    expect(description).toMatch(/poll/i);
    expect(description).toMatch(/schedul/i);
    expect(description).toMatch(/50/);
  });
});

describe('no tool asks the agent for an author field', () => {
  // The daemon derives `from` from the presenting token and rejects a payload
  // that sets one. A schema that advertised these would invite an agent to
  // assert an identity it does not have — friction entry 9, one layer down.
  it.each(['from', 'raisedBy', 'by'])('never declares `%s`', (field) => {
    for (const t of TOOLS) {
      expect(Object.keys(t.inputSchema.properties), `${t.name}`).not.toContain(field);
    }
  });
});

describe('write tools tell the agent to expect more than one event', () => {
  it('says so on vote and on ack_task, which each append two', () => {
    expect(tool('vote').description).toMatch(/two events|both/i);
    expect(tool('ack_task').description).toMatch(/two events/i);
  });
});
