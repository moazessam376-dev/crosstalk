import { describe, expect, it } from 'vitest';
import {
  HEAD_LIMIT,
  MESSAGE_TAGS,
  TAGS,
  refuseMessage,
  renderTagTable,
  type MessageTag,
} from '../../src/core/says.js';

/**
 * The one rule that worked.
 *
 * Two rules governed the vault-team run. "Post short asks and offers, not
 * narration" was prose, and the median message came in at 1429 characters. The
 * over-cap refusal was mechanical, and there were zero violations in 1187
 * events. Same agents, same run. This file is the second kind of rule.
 */

const ROSTER = ['peer-1', 'peer-2', 'peer-3'];
const CTX = { from: 'peer-1', roster: ROSTER };

function valid(tag: MessageTag): Record<string, unknown> {
  const spec = TAGS[tag];
  return {
    tag,
    head: spec.example,
    ...(spec.requires.includes('ref') ? { ref: 'src/wind.ts' } : {}),
    ...(spec.requires.includes('to') ? { to: 'peer-2' } : {}),
    ...(spec.where === 'direct' ? { room: 'dm:peer-1~peer-2' } : { room: '#floor' }),
  };
}

describe('the tag table', () => {
  it('is not empty, and holds at least one head-only tag', () => {
    // Vacuity guard. Every assertion below iterates the table, so a table that
    // silently emptied would pass all of them.
    expect(MESSAGE_TAGS.length).toBeGreaterThan(0);
    expect(MESSAGE_TAGS.some((tag) => TAGS[tag].body === 0)).toBe(true);
    for (const tag of MESSAGE_TAGS) {
      expect(TAGS[tag].example.length, tag).toBeGreaterThan(0);
      expect(TAGS[tag].example.length, tag).toBeLessThanOrEqual(HEAD_LIMIT);
    }
  });

  for (const tag of MESSAGE_TAGS) {
    it(`accepts a well-formed ${tag}`, () => {
      expect(refuseMessage(valid(tag), CTX)).toBeNull();
    });

    it(`refuses a ${tag} body one character over budget`, () => {
      const spec = TAGS[tag];
      const draft = { ...valid(tag), body: 'x'.repeat(spec.body + 1) };
      const refusal = refuseMessage(draft, CTX);

      expect(refusal, tag).not.toBeNull();
      // The anti-anchor rule: an agent told "the limit is 400" aims at 400 next
      // time. It is told how much to cut instead.
      expect(refusal, tag).not.toContain(String(spec.body));
    });
  }
});

describe('what a message must carry', () => {
  it('refuses an untagged message, and the refusal is the guide', () => {
    const refusal = refuseMessage({ room: '#floor', head: 'something' }, CTX);
    for (const tag of MESSAGE_TAGS) expect(refusal).toContain(tag);
  });

  it('refuses a missing, empty or multi-line head', () => {
    expect(refuseMessage({ tag: 'status', room: '#floor' }, CTX)).toContain('head');
    expect(refuseMessage({ tag: 'status', room: '#floor', head: '   ' }, CTX)).toContain('head');
    expect(refuseMessage({ tag: 'status', room: '#floor', head: 'one\ntwo' }, CTX)).toContain('one line');
  });

  it('refuses a body on a tag that is one line', () => {
    const refusal = refuseMessage({ ...valid('status'), body: 'and then some detail' }, CTX);
    expect(refusal).toContain('one line');
  });

  it('refuses a result with no ref', () => {
    const { ref: _ref, ...withoutRef } = valid('result');
    expect(refuseMessage(withoutRef, CTX)).toContain('ref');
  });

  it('refuses a tag this seat does not have', () => {
    const refusal = refuseMessage(valid('plan'), { ...CTX, allowed: ['status', 'result'] });
    expect(refusal).toContain('not one of your tags');
    // And the same seat can still post one it does have.
    expect(refuseMessage(valid('status'), { ...CTX, allowed: ['status', 'result'] })).toBeNull();
  });
});

describe('routing one-to-one traffic out of the room', () => {
  it('refuses an ask posted to the floor, and names the fix', () => {
    const refusal = refuseMessage({ ...valid('ask'), room: '#floor' }, CTX);
    expect(refusal).toContain('to: "peer-2"');
    expect(refusal).toContain('side room');
  });

  it('refuses a gate posted in a side room', () => {
    // assertedGates only reads #floor. A gate asserted anywhere else is not
    // counted, and nothing ever said so — the phase just never advanced.
    expect(refuseMessage({ ...valid('gate'), room: 'dm:peer-1~peer-2' }, CTX)).toContain('#floor');
  });

  it('refuses a floor post that opens by naming another seat', () => {
    const refusal = refuseMessage({ ...valid('note'), head: 'peer-2 — the guard is silent on a symlink' }, CTX);
    expect(refusal).toContain('to: "peer-2"');
  });

  it('leaves alone a head that mentions a seat without addressing one', () => {
    // The neighbouring cases, and the reason this is a roster lookup rather
    // than a pattern. Both of these are about a seat, not to one.
    expect(refuseMessage({ ...valid('note'), head: 'peer-2 and peer-3 both landed' }, CTX)).toBeNull();
    expect(refuseMessage({ ...valid('note'), head: "peer-2's split holds" }, CTX)).toBeNull();
    expect(refuseMessage({ ...valid('note'), head: 'main — the branch, not the seat' }, CTX)).toBeNull();
    // And addressing yourself is not addressing anyone.
    expect(refuseMessage({ ...valid('note'), head: 'peer-1 — note to self' }, CTX)).toBeNull();
  });
});

describe('the rendered guide', () => {
  it('names every tag, and no budget', () => {
    const rendered = renderTagTable();
    for (const tag of MESSAGE_TAGS) expect(rendered).toContain(`\`${tag}\``);
    for (const tag of MESSAGE_TAGS) {
      if (TAGS[tag].body > 0) expect(rendered).not.toContain(String(TAGS[tag].body));
    }
    expect(rendered).not.toContain(String(HEAD_LIMIT));
  });

  it('narrows to the tags a seat actually has', () => {
    const rendered = renderTagTable(['status', 'result']);
    expect(rendered).toContain('`status`');
    expect(rendered).not.toContain('`plan`');
  });
});
