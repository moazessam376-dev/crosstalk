import { describe, it, expect } from 'vitest';
import { TOOLS, TOOLS_BY_NAME } from '../../src/mcp/tools.js';

function tool(name: string) {
  const found = TOOLS_BY_NAME.get(name);
  if (found === undefined) throw new Error(`No tool named ${name}`);
  return found;
}

function property(name: string, key: string): { description?: string; enum?: string[] } {
  return (tool(name).inputSchema.properties[key] ?? {}) as { description?: string; enum?: string[] };
}

describe('the tools an agent sees', () => {
  it('is exactly the four team-OS verbs', () => {
    expect(TOOLS.map((entry) => entry.name)).toEqual(['inbox', 'say', 'act', 'claim']);
  });

  it('keeps every description short enough to name the verb, not teach the thesis', () => {
    for (const entry of TOOLS) {
      expect(entry.description.length, `${entry.name} description`).toBeGreaterThan(0);
      expect(entry.description.length, `${entry.name} description`).toBeLessThanOrEqual(200);
      expect(entry.inputSchema.type).toBe('object');
    }
  });

  it('fails a 201-character description so the cap is not decorative', () => {
    const tooLong = 'x'.repeat(201);
    expect(tooLong.length).toBe(201);
    for (const entry of TOOLS) {
      expect(entry.description.length).toBeLessThan(tooLong.length);
    }
  });

  it('names the verb each tool is for', () => {
    expect(tool('inbox').description.toLowerCase()).toMatch(/unread|idle|wait/);
    expect(tool('say').description.toLowerCase()).toMatch(/room|post|board/);
    expect(tool('act').description.toLowerCase()).toMatch(/ack|assign|done/);
    expect(tool('claim').description.toLowerCase()).toMatch(/court|falsifier|contradict/);
  });
});

describe('court stays in the schema, not as fifteen doors', () => {
  it('lists every verdict on claim, so an agent does not guess the vocabulary', () => {
    expect(property('claim', 'verdict').enum).toEqual([
      'accept',
      'contest',
      'clarify',
      'concede',
      'amend',
      'uphold',
    ]);
  });

  it('says what a falsifier is on the claim parameter', () => {
    const description = property('claim', 'falsifier').description ?? '';
    expect(description).toMatch(/wrong/i);
    expect(description.length).toBeGreaterThan(20);
  });
});

describe('no tool asks the agent for an author field', () => {
  it.each(['from', 'raisedBy', 'by'])('never declares `%s`', (field) => {
    for (const entry of TOOLS) {
      expect(Object.keys(entry.inputSchema.properties), `${entry.name}`).not.toContain(field);
    }
  });
});
