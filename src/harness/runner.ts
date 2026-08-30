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

  const loop = (async () => {
    while (running) {
      const inbox = await Promise.race([
        args.wait(),
        exit.then(() => undefined),
      ]);
      if (!running || inbox === undefined) return;
      if (inbox.unread.length === 0 && inbox.next === 'idle') continue;
      await args.write(format(inbox));
    }
  })();

  await Promise.race([loop, exit]);
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
