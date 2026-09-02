import { execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Inbox } from '../core/inbox.js';
import { humanBytes } from '../core/attachments.js';

export type ExecFile = typeof execFileCallback;

/**
 * Whether a seat can be handed the board right now.
 *
 * Not a message. The vault-team run put 622 of its 1187 events on `#floor` —
 * 52% of the whole board — saying a seat had stopped taking turns and then that
 * it had started again, under `@human`'s name. That is state, and state
 * overwrites: `/presence` holds one row per seat and costs nothing to update.
 */
export interface SeatHealth {
  stuck: boolean;
  /** The refusal, when there is one. Absent on recovery. */
  why?: string;
}

/**
 * How many refusals in a row before a seat counts as stuck.
 *
 * One refusal is a seat that happened to be mid-dialog when a card arrived; it
 * takes the next one. Reporting that was what made the old notice oscillate.
 */
const STUCK_AFTER = 3;

/**
 * Wait in-process. Write one turn when a card arrives. Never put the model
 * in an inbox poll loop. Never restart a dead child.
 */
export async function driveSupervised(args: {
  wait: () => Promise<Inbox>;
  write: (turn: string) => Promise<void>;
  exited: Promise<number | null>;
  /** The board. Reserved for the child exiting — nothing else belongs there. */
  notify: (body: string) => Promise<void>;
  /** Presence. Everything about whether the seat is reachable goes here. */
  onHealth?: (health: SeatHealth) => Promise<void> | void;
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
  // has to still arrive.
  //
  // Reported on the transition only, and to presence rather than the board. The
  // transition guard was already here and was not enough: a seat that refuses
  // one turn and takes the next flips it every time, which is how 311 pairs of
  // "stuck"/"taking turns again" reached `#floor`. `STUCK_AFTER` is the missing
  // half — the guard says report each change, the threshold says what counts as
  // a change.
  let refusals = 0;
  let reportedStuck = false;
  let lastTurn: string | undefined;

  const health = async (state: SeatHealth): Promise<void> => {
    await args.onHealth?.(state);
  };

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
        refusals = 0;
        if (reportedStuck) {
          reportedStuck = false;
          // Cheap, because presence overwrites. A seat whose harness runs the
          // hooks would clear this itself on its next tool call; one that does
          // not — `codex exec` runs none — would otherwise read blocked for the
          // rest of the run.
          await health({ stuck: false });
        }
      } catch (error) {
        refusals += 1;
        // Re-reported on every refusal past the threshold, not only on the
        // transition. `activityOf` drops a row older than `PRESENCE_TTL_MS`, so
        // a seat that reported stuck once and then kept refusing would read as
        // healthy five minutes later. Overwriting state is cheap to refresh;
        // that is the whole reason this is not an event.
        if (refusals >= STUCK_AFTER) {
          reportedStuck = true;
          await health({ stuck: true, why: error instanceof Error ? error.message : String(error) });
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
    const what = card.tag ?? card.kind;
    lines.push('', `[${card.seq}] ${card.from}${where} — ${what}`);
    // The head first and on its own line: it is the author's own summary, and
    // a seat deciding what to read should not have to parse a paragraph to
    // find out what it is about.
    if (card.body !== undefined && card.body !== card.summary) lines.push(card.summary);
    lines.push(card.body ?? card.summary);
    if (card.truncated === true) lines.push('(cut — read the log for the rest)');
    if (card.ref !== undefined) lines.push(`ref: ${card.ref}`);
    // A path, not bytes. The seat has its own Read tool; what it lacks is
    // somewhere to point it. The type and size are there so it can decide
    // whether opening a 40 MB video is what it wants to do next.
    for (const attachment of card.attachments ?? []) {
      lines.push(`attached: ${attachment.path} (${attachment.type}, ${humanBytes(attachment.bytes)})`);
    }
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
