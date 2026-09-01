import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { MessageTag } from '../contracts/say.js';
import { renderTagTable, TAGS } from '../core/says.js';

/**
 * The board vocabulary, as a skill file a Claude Code seat can be pointed at.
 *
 * **Generated, never authored.** It renders from `TAGS` — the same record the
 * `say` schema, the brief fragment and every daemon refusal render from — so it
 * cannot drift from what is actually enforced. An authored skill file would be
 * a fourth copy of the vocabulary, and the fourth copy is the one that goes
 * stale and starts teaching a rule the daemon does not have.
 *
 * Be clear-eyed about what this is worth. The measured evidence says the
 * *refusal* is what changes behaviour: over 1187 events, a prose rule in the
 * brief produced a median message of 1429 characters against a stated cap of
 * 1500, while the one mechanical rule produced zero violations. A skill file is
 * a longer version of the brief line that already failed that test. It ships
 * because it costs one generated file and it is where a Claude Code seat looks
 * — not because it is expected to do the work the refusal does.
 */
export const SKILL_DIR = join('.claude', 'skills', 'crosstalk-board');
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');

/**
 * The file's body, from the tag table.
 *
 * No sizes anywhere, deliberately, and the same rule the brief follows: the cap
 * read `1500` in three templates and the median message was 1429 characters. A
 * writer told a number spends it. Refusals name the overage instead.
 */
export function renderSkill(tags: readonly MessageTag[]): string {
  const rows = tags.map((tag) => {
    const spec = TAGS[tag];
    const needs = spec.requires.length === 0 ? '—' : spec.requires.map((field) => `\`${field}\``).join(', ');
    return `| \`${tag}\` | ${spec.need} | ${needs} | ${spec.where} |`;
  });

  return `---
name: crosstalk-board
description: How to say things on the crosstalk board — the tags, what each is for, and when to ask a teammate rather than guess.
---

# The crosstalk board

You are on a team. The board is how the team wins, and it is the only thing
your teammates can see: they cannot read your reasoning, your files, or your
terminal. What you post is the whole of what they know.

## Every message is a tag and a head

The head is the message. Most messages need no body at all.

| tag | for | requires | where |
| --- | --- | --- | --- |
${rows.join('\n')}

The daemon enforces this. A message that does not fit is refused with what to
change, so you will find out immediately rather than being quietly ignored.

## Say less than you want to

Write the head as though the person reading it is mid-task and will read one
line. Put depth in a file or a commit and name it with \`ref\` — a pointer
your teammate can follow when they need it beats a paragraph they must read
now. Keep your reasoning out of the room: what you decided is useful, how you
got there is not.

Do not narrate. If \`act\` already recorded it, do not also say it.

## Ask early, ask one seat

An \`ask\` goes to one teammate, by name, in a side room — not to the floor.
Ask when:

- two of you could be writing the same file, and you want it settled before
  either of you does
- a decision belongs to someone else's slice and you would be guessing
- you are blocked and the person who can unblock you is on this team

Do not ask for permission to do your own job, and do not ask for review you
were not promised. Answer a directed question before your next work step: a
teammate waiting on you is the most expensive thing on the board.

## When you are stuck, say so with \`blocked\`

Name what stopped you and who can unblock it. A seat that goes quiet is
indistinguishable from a seat that is working, and both times this project's
benchmark lost an hour, that was the shape of it.
`;
}

/**
 * Write the skill into a seat's workspace.
 *
 * Alongside `.claude/settings.json`, which `init` already writes per worktree,
 * and added to the untracked list for the same reason: crosstalk put it in
 * somebody's checkout, so crosstalk keeps it out of their next commit.
 */
export async function writeBoardSkill(args: {
  repo: string;
  workspace: string;
  tags: readonly MessageTag[];
}): Promise<string> {
  const dir = join(resolve(args.repo), args.workspace, SKILL_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  await writeFile(path, renderSkill(args.tags), 'utf8');
  return path;
}

/** Kept beside the renderer so a reader can see the two halves agree. */
export { renderTagTable };
