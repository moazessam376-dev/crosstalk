import type { ParticipantId } from '../contracts/participant.js';
import { FLOOR } from '../contracts/room.js';
import { HEAD_LIMIT, MESSAGE_TAGS, isMessageTag, type MessageTag } from '../contracts/say.js';
import { parseRoom } from './rooms.js';

export { HEAD_LIMIT, MESSAGE_TAGS, isMessageTag, type MessageTag };

/** Where a tag belongs. `direct` means a side room with one named seat. */
export type TagWhere = 'floor' | 'direct' | 'any';

export interface TagSpec {
  tag: MessageTag;
  /** One line, in the seat's language. Rendered into the brief and the schema. */
  need: string;
  /** Body characters this tag may carry. Zero means the head is the whole message. */
  body: number;
  requires: readonly ('to' | 'ref')[];
  where: TagWhere;
  /** One real message, short enough to be a pattern rather than a template. */
  example: string;
}

/**
 * The table. This is the communication guide — the brief, the tool schema and
 * every refusal are renderings of it, so there is one place to author and
 * nothing that can drift.
 *
 * Grounded in two measurements. PACT (arXiv 2606.05304) constrains a public
 * message to action, state and result and keeps private reasoning out of it,
 * for a 50.4% cut in input tokens on SWE-agent. METR's account of the Hugging
 * Face incident describes the board that actually worked: tagged message kinds,
 * per-agent mailboxes once the flat room grew, and artifacts referenced by name
 * rather than pasted inline.
 */
export const TAGS: Readonly<Record<MessageTag, TagSpec>> = {
  status: {
    tag: 'status',
    need: 'What you are doing now.',
    body: 0,
    requires: [],
    where: 'floor',
    example: 'taking the water and the boat',
  },
  result: {
    tag: 'result',
    need: 'What you finished, and where the evidence is.',
    body: 400,
    requires: ['ref'],
    where: 'floor',
    example: 'wind sim lands, 14 tests green',
  },
  ask: {
    tag: 'ask',
    need: 'One question, to one seat.',
    body: 300,
    requires: ['to'],
    where: 'direct',
    example: 'does the HUD own the score, or does the sim?',
  },
  answer: {
    tag: 'answer',
    need: 'The answer to one ask.',
    body: 400,
    requires: ['to'],
    where: 'direct',
    example: 'the sim owns it; the HUD reads it',
  },
  blocked: {
    tag: 'blocked',
    need: 'What has stopped you, and who can unstop it.',
    body: 300,
    requires: ['to'],
    where: 'any',
    example: 'cannot build: contract has no LaneBearing yet',
  },
  gate: {
    tag: 'gate',
    need: 'A phase gate you are asserting, with what shows it.',
    body: 900,
    requires: ['ref'],
    where: 'floor',
    example: 'my slice is done and I have watched it run',
  },
  plan: {
    tag: 'plan',
    need: 'The spec, the contract, or the split.',
    body: 1500,
    requires: ['ref'],
    where: 'floor',
    example: 'split: peer-1 sim, peer-2 render, peer-3 HUD',
  },
  note: {
    tag: 'note',
    need: 'Anything else worth the room knowing.',
    body: 300,
    requires: [],
    where: 'any',
    example: 'main moved; rebase before you push',
  },
};

/**
 * The guide as a seat reads it.
 *
 * Deliberately without a single number. The cap appeared as `1500` three times
 * in the brief templates and twice more in the `say` tool description, which is
 * in the model's context on every call — and the median message came in at 95%
 * of it. A budget stated to the writer is a target; a budget enforced on the
 * write is a budget. The numbers live in refusals, after the fact.
 */
export function renderTagTable(tags: readonly MessageTag[] = MESSAGE_TAGS): string {
  const lines = ['Every board message carries a `tag` and a one-line `head`. The head is the message.'];
  for (const tag of tags) {
    const spec = TAGS[tag];
    const needs = spec.requires.length === 0 ? '' : ` (${spec.requires.map((field) => `needs \`${field}\``).join(', ')})`;
    lines.push(`- \`${tag}\` — ${spec.need}${needs} e.g. "${spec.example}"`);
  }
  lines.push('Put depth in a file or a commit and name it with `ref`. Keep your reasoning out of the room.');
  return lines.join('\n');
}

export interface MessageDraft {
  room?: string;
  tag?: unknown;
  head?: unknown;
  body?: unknown;
  to?: unknown;
  ref?: unknown;
}

export interface SayContext {
  /** The tags this seat's shape allows. Undefined means the shape does not say. */
  allowed?: readonly MessageTag[];
  /** Live participant ids, for the addressed-head check. */
  roster?: readonly ParticipantId[];
  from: ParticipantId;
}

/**
 * Report the overage, never the budget.
 *
 * This looks like an omission and is not. Telling an agent "the limit is 400"
 * hands it a number to aim at next time, which is exactly how 1500 became a
 * median of 1429. Telling it "312 characters too long" is actionable and
 * carries nothing to anchor on.
 */
function tooLong(what: string, actual: number, allowed: number): string {
  return `${what} is ${actual - allowed} characters too long.`;
}

/**
 * Why this message cannot be posted, or `null` if it can.
 *
 * Every refusal names the fix, because a refusal an agent cannot act on is a
 * retry loop, and a retry loop against a validating daemon burns tokens faster
 * than an unvalidated board ever did.
 */
export function refuseMessage(draft: MessageDraft, ctx: SayContext): string | null {
  if (!isMessageTag(draft.tag)) {
    return `say needs a tag. ${renderTagTable(ctx.allowed ?? MESSAGE_TAGS)}`;
  }
  const spec = TAGS[draft.tag];

  if (ctx.allowed !== undefined && !ctx.allowed.includes(draft.tag)) {
    return `\`${draft.tag}\` is not one of your tags in this shape. Yours: ${ctx.allowed.join(', ')}.`;
  }

  if (typeof draft.head !== 'string' || draft.head.trim() === '') {
    return `say needs a one-line \`head\` — it is the message. ${spec.need} e.g. "${spec.example}"`;
  }
  if (draft.head.includes('\n')) {
    return 'a `head` is one line. Anything that needs a second line is `body`, or a file named with `ref`.';
  }
  if (draft.head.length > HEAD_LIMIT) {
    return `${tooLong('head', draft.head.length, HEAD_LIMIT)} Move the rest into \`body\`, or into a file named with \`ref\`.`;
  }

  const body = typeof draft.body === 'string' ? draft.body : '';
  if (body !== '' && spec.body === 0) {
    return `a \`${draft.tag}\` is one line. If it needs a body it is a \`note\`, or a \`result\` with a \`ref\`.`;
  }
  if (body.length > spec.body) {
    return `${tooLong(`a \`${draft.tag}\` body`, body.length, spec.body)} Put the write-up in the artifact and name it with \`ref\` — nothing has to be cut.`;
  }

  for (const field of spec.requires) {
    if (field === 'ref' && typeof draft.ref !== 'string') {
      return `a \`${draft.tag}\` needs a \`ref\` — a path, a SHA, or a file you wrote. Without one it is a statement nobody can check.`;
    }
    if (field === 'to' && typeof draft.to !== 'string') {
      return `a \`${draft.tag}\` names one seat. Pass \`to\`, and leave \`room\` off — Crosstalk opens the side room.`;
    }
  }

  const room = draft.room ?? FLOOR;
  const kind = parseRoom(room).kind;

  if (spec.where === 'direct' && kind !== 'dm') {
    return (
      `an \`${draft.tag}\` goes to one seat, not to the whole room. Drop \`room\` and pass ` +
      `\`to: "${String(draft.to)}"\` — @human is in that room too, so it is a side room and not a back channel.`
    );
  }
  if (spec.where === 'floor' && kind !== 'floor') {
    // `gate` especially: assertedGates only reads #floor, so a gate posted in a
    // side room is not counted and nothing ever says so. The phase then stalls
    // with no visible cause, which is the failure this whole file exists over.
    return `a \`${draft.tag}\` belongs on ${FLOOR}, where the team can see it. Leave \`to\` off and post it to the room.`;
  }

  return addressedHead(draft.head, ctx);
}

/**
 * A `#floor` post that opens by naming one seat.
 *
 * 312 of the vault-team run's 560 peer messages began `peer-N — `, and every
 * one of them was read in full by three seats who were not being spoken to.
 * Twelve set `to`; none used a side room. The habit is real and prose did not
 * move it: the brief's last line and the operator's opening message both said
 * to use side rooms.
 *
 * A roster lookup rather than a pattern, so `main — the branch` is not mistaken
 * for an address, and the possessive and conjunction forms are left alone —
 * "peer-2's split holds" is about a seat, not to one.
 */
function addressedHead(head: string, ctx: SayContext): string | null {
  const found = /^([A-Za-z0-9][A-Za-z0-9-]{0,31})\s*[—:-]\s/.exec(head);
  const named = found?.[1];
  if (named === undefined || named === ctx.from) return null;
  if (ctx.roster === undefined || !ctx.roster.includes(named)) return null;

  return (
    `this opens by naming ${named}, so send it to ${named}: pass \`to: "${named}"\` and leave \`room\` off. ` +
    'Posting it to the room makes every other seat read it in full.'
  );
}
