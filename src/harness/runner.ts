import { execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Inbox } from '../core/inbox.js';

export type ExecFile = typeof execFileCallback;

/**
 * Wait in-process. Write one turn when a card arrives. Never put the model
 * in an inbox poll loop. Never restart a dead child.
 */
export async function driveSupervised(args: {
  wait: () => Promise<Inbox>;
  write: (turn: string) => Promise<void>;
  exited: Promise<number | null>;
  notify: (body: string) => Promise<void>;
  formatTurn?: (inbox: Inbox) => string;
}): Promise<void> {
  const format = args.formatTurn ?? defaultTurn;
  let running = true;

  const exit = args.exited.then(async (code) => {
    running = false;
    await args.notify(`supervised child exited (${code ?? 'null'})`);
  });

  // A seat can be alive and unable to take a turn: it is sitting on a
  // confirmation it drew itself, and typing at it would answer that rather than
  // submit anything. `write` refuses in that case, and refusing must not end
  // the wake loop — the operator answers the dialog and the next board event
  // has to still arrive. Reported on the transition only, so a seat stuck for
  // an hour says so once rather than every fifty seconds.
  let stuck = false;
  let lastTurn: string | undefined;

  const loop = (async () => {
    while (running) {
      const inbox = await Promise.race([
        args.wait(),
        exit.then(() => undefined),
      ]);
      if (!running || inbox === undefined) return;
      if (inbox.unread.length === 0 && inbox.next === 'idle') continue;
      const turn = format(inbox);
      // Never say the same thing twice, whatever the inbox claims is unread.
      //
      // This first only skipped repeats when nothing was unread, which left the
      // worse half of the bug open: a card that keeps being handed back as
      // unread produces the same turn every time, and the seat gets its own
      // brief typed into its composer again and again. That is what the
      // operator was watching — one #floor message pasted into a focused
      // terminal over and over.
      //
      // Identity is the right test either way. A genuinely new card changes the
      // turn: a different seq, a different body, a different status. A turn
      // byte-identical to the last one carries nothing the seat has not read.
      if (turn === lastTurn) continue;
      lastTurn = turn;
      try {
        await args.write(turn);
        if (stuck) {
          stuck = false;
          await args.notify('is taking turns again');
        }
      } catch (error) {
        if (!stuck) {
          stuck = true;
          const why = error instanceof Error ? error.message : String(error);
          await args.notify(`could not be given the board: ${why}`);
        }
      }
    }
  })();

  await Promise.race([loop, exit]);
}

/**
 * A turn as prose, because a model reads it.
 *
 * `defaultTurn` hands over the raw inbox JSON, which was fine when a card was a
 * 120-character summary and there was nothing else in it. Now that a card
 * carries the whole message, the difference between a JSON blob and a readable
 * turn is the difference between a seat skimming and a seat reading.
 */
export function boardTurn(inbox: Inbox): string {
  const lines: string[] = ['Crosstalk board — new since your last turn.'];

  for (const card of inbox.unread) {
    const where = card.room === undefined ? '' : ` in ${card.room}`;
    lines.push('', `[${card.seq}] ${card.from}${where} — ${card.kind}`);
    lines.push(card.body ?? card.summary);
    if (card.truncated === true) lines.push('(cut — read the log for the rest)');
    if (card.ref !== undefined) lines.push(`ref: ${card.ref}`);
  }

  if (inbox.mine.length > 0) {
    lines.push('', 'Yours:');
    for (const task of inbox.mine) lines.push(`- ${task.id} ${task.title} (${task.state})`);
  }

  if (inbox.next !== undefined) lines.push('', `next: ${inbox.next}`);
  return lines.join('\n');
}

export function defaultTurn(inbox: Inbox): string {
  return JSON.stringify({
    you: inbox.you,
    role: inbox.role,
    next: inbox.next,
    unread: inbox.unread,
    mine: inbox.mine,
  });
}

export function spawnArgv(spawn: string[], prompt: string): string[] {
  return [...spawn.slice(1), prompt];
}

export function spawnSupervised(args: {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFile;
}): ChildProcess {
  const execFile = args.execFile ?? execFileCallback;
  const [file, ...argv] = args.argv;
  if (file === undefined) throw new Error('spawn argv is empty');
  return execFile(file, argv, {
    cwd: args.cwd,
    env: args.env,
    windowsHide: true,
  });
}

/** Read stdout lines from a child that speaks JSONL. Unused by the wake path. */
export function linesOf(child: ChildProcess): AsyncIterable<string> {
  return createInterface({ input: child.stdout! });
}
