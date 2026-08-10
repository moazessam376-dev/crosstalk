import { describe, it, expect } from 'vitest';

import { commentRef, isPullable, pollInbound, renderInboundMessage } from '../../src/mirror/poll.js';
import { renderClaimComment } from '../../src/mirror/render.js';

import type { InboundComment } from '../../src/mirror/poll.js';
import type { Claim } from '../../src/contracts/claim.js';

function comment(overrides: Partial<InboundComment> = {}): InboundComment {
  return {
    id: 5240847121,
    body: 'ship the refund fix before the sprint ends',
    authorAssociation: 'OWNER',
    ...overrides,
  };
}

function settledClaim(): Claim {
  return {
    id: 'C-118',
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/economy.ts:41',
    assertion: 'double-credit',
    severity: 'defect',
    falsifier: 'one credit refutes this',
    evidence: [],
    state: 'resolved',
    resolution: 'upheld',
    rounds: 2,
  };
}

/** A poller wired to record what it posted instead of posting it. */
function recorder() {
  const posted: string[] = [];
  return {
    posted,
    post: async (body: string): Promise<void> => {
      posted.push(body);
    },
  };
}

describe('which comments the inbound channel pulls', () => {
  it('pulls a comment authored by the repository owner', () => {
    expect(isPullable(comment({ authorAssociation: 'OWNER' }))).toBe(true);
  });

  it('does not pull a comment from a drive-by contributor', () => {
    expect(isPullable(comment({ authorAssociation: 'CONTRIBUTOR' }))).toBe(false);
    expect(isPullable(comment({ authorAssociation: 'NONE' }))).toBe(false);
  });

  /**
   * The echo loop, and the reason author alone cannot close it: every agent on
   * this project posts under the repository owner's credential, so the mirror's
   * own writes come back as `OWNER` too. The marker in the body is what
   * separates them.
   */
  it('does not pull a comment the mirror itself wrote, even though it is OWNER-authored', () => {
    const own = comment({ body: renderClaimComment(settledClaim()), authorAssociation: 'OWNER' });

    expect(own.authorAssociation).toBe('OWNER');
    expect(isPullable(own)).toBe(false);
  });

  it('does not pull a message it previously delivered to the floor', () => {
    const relayed = comment({ body: renderInboundMessage(comment()) });

    expect(isPullable(relayed)).toBe(false);
  });
});

describe('polling the inbound channel', () => {
  it('delivers an owner comment to the floor once, and not again on the second poll', async () => {
    const sink = recorder();
    const delivered: string[] = [];
    const options = {
      comments: async () => [comment()],
      post: sink.post,
      // Stateless dedup: the mirror asks the log what it already relayed rather
      // than remembering it, so a restart does not replay every past comment
      // into #floor.
      alreadyDelivered: (id: number) => delivered.some((body) => body.includes(commentRef(id))),
      mode: 'two-way-human' as const,
    };

    const first = await pollInbound(options);
    delivered.push(...sink.posted);
    const second = await pollInbound(options);

    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(sink.posted).toHaveLength(1);
    expect(sink.posted[0]).toContain('ship the refund fix before the sprint ends');
  });

  /**
   * The neighbouring case for the test above: if `alreadyDelivered` always said
   * yes, the first poll would deliver nothing and the assertion `second === 0`
   * would still hold. This proves the second poll is quiet because the comment
   * was seen, not because the poller is inert.
   */
  it('delivers a second, different comment on the second poll', async () => {
    const sink = recorder();
    const delivered: string[] = [];
    let batch = [comment({ id: 1, body: 'first' })];
    const options = {
      comments: async () => batch,
      post: sink.post,
      alreadyDelivered: (id: number) => delivered.some((body) => body.includes(commentRef(id))),
      mode: 'two-way-human' as const,
    };

    await pollInbound(options);
    delivered.push(...sink.posted);
    batch = [comment({ id: 1, body: 'first' }), comment({ id: 2, body: 'second' })];
    const second = await pollInbound(options);

    expect(second.delivered).toBe(1);
    expect(sink.posted).toHaveLength(2);
    expect(sink.posted[1]).toContain('second');
  });

  it('polls nothing in one-way mode', async () => {
    const sink = recorder();
    let asked = false;

    const result = await pollInbound({
      comments: async () => {
        asked = true;
        return [comment()];
      },
      post: sink.post,
      alreadyDelivered: () => false,
      mode: 'one-way',
    });

    expect(result.delivered).toBe(0);
    expect(sink.posted).toHaveLength(0);
    expect(asked).toBe(false);
  });

  it('polls nothing when the mirror is off', async () => {
    const sink = recorder();

    const result = await pollInbound({
      comments: async () => [comment()],
      post: sink.post,
      alreadyDelivered: () => false,
      mode: 'off',
    });

    expect(result.delivered).toBe(0);
    expect(sink.posted).toHaveLength(0);
  });
});

describe('the relayed message', () => {
  it('carries the comment text and a reference the mirror can recognise later', () => {
    const body = renderInboundMessage(comment({ id: 42, body: 'merge it' }));

    expect(body).toContain('merge it');
    expect(body).toContain(commentRef(42));
  });

  it('does not confuse one comment id for another', () => {
    const body = renderInboundMessage(comment({ id: 42 }));

    expect(body).toContain(commentRef(42));
    expect(body).not.toContain(commentRef(4));
  });
});
