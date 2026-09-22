import {
  ALL,
  HUMAN,
  joinAgent,
  listAgents,
  loadCursor,
  loadNotified,
  nameError,
  saveCursor,
  type Cursor,
} from './agents.js';
import { formatLine, hhmm, table } from './format.js';
import { BoardError } from './fsutil.js';
import { UNLIMITED, collect, isFor, type Limit } from './inbox.js';
import { appendMessage, nextId, readFrom } from './messages.js';
import { currentRun, ensureRun, newRun, openRun, runPaths, type Run } from './runs.js';
import { waitForChange } from './wait.js';

export const INBOX_LIMIT: Limit = { count: 20, chars: 4000 };
export const MAX_WAIT_S = 50;
const RECHECK_MS = 1000;
/** A hook notice is one short line. */
const NOTICE_TOKENS = 15;

export function etiquette(name: string): string {
  return [
    `You are "${name}" on a Crosstalk board. Pass as: "${name}" on every Crosstalk call.`,
    'Send a message only when: you are about to edit a file another agent may be editing; you are blocked on something another agent owns; or you changed something others depend on.',
    'Never send progress reports. Your result reaches whoever started you.',
    'When you are told you have unread Crosstalk messages, call inbox and act on them within your task.',
  ].join('\n');
}

export class Board {
  constructor(readonly root: string) {}

  async join(name: string, rejoin = false): Promise<string> {
    const run = await ensureRun(this.root);
    const { rejoined } = await joinAgent(run, name, rejoin);
    return `${rejoined ? 'rejoined' : 'joined'} as ${name} (run ${run.id})\n\n${etiquette(name)}`;
  }

  async send(as: string, to: string | readonly string[], text: string): Promise<string> {
    const run = as === HUMAN ? await ensureRun(this.root) : await this.#run();
    if (as !== HUMAN) await this.#cursor(run, as);
    const recipients = parseRecipients(to, as);
    if (text.trim() === '') throw new BoardError('the message is empty');

    const { msgs } = runPaths(run);
    const id = await nextId(msgs, as);
    await appendMessage(msgs, { id, ts: new Date().toISOString(), from: as, to: recipients, text });

    const joined = new Set(await listAgents(run));
    const waiting = recipients.filter((r) => r !== ALL && r !== HUMAN && !joined.has(r));
    if (waiting.length === 0) return `sent ${id}`;
    return `sent ${id}; ${waiting.join(', ')} ${waiting.length === 1 ? 'has' : 'have'} not joined yet and will get it on joining`;
  }

  async inbox(as: string, waitS = 0): Promise<{ text: string; count: number }> {
    const run = await this.#run();
    const cursor = await this.#cursor(run, as);
    const { msgs } = runPaths(run);
    const accept = isFor(as, cursor.joinedAt);
    const deadline = Date.now() + Math.min(Math.max(waitS, 0), MAX_WAIT_S) * 1000;

    let got = await collect(msgs, cursor.offsets, accept, INBOX_LIMIT);
    while (got.messages.length === 0 && Date.now() < deadline) {
      await waitForChange(msgs, Math.min(RECHECK_MS, deadline - Date.now()));
      got = await collect(msgs, cursor.offsets, accept, INBOX_LIMIT);
    }

    const chars = got.messages.reduce((sum, msg) => sum + msg.text.length, 0);
    await saveCursor(run, {
      name: cursor.name,
      joinedAt: cursor.joinedAt,
      offsets: got.next,
      stats: {
        inboxCalls: cursor.stats.inboxCalls + 1,
        delivered: cursor.stats.delivered + got.messages.length,
        deliveredChars: cursor.stats.deliveredChars + chars,
      },
    });

    const lines = got.messages.length === 0 ? ['no new messages'] : got.messages.map(formatLine);
    if (got.more > 0) lines.push(`${got.more} more; call inbox again`);
    if (got.corrupt > 0) lines.push(`${got.corrupt} unreadable line${got.corrupt === 1 ? '' : 's'} skipped`);
    if (cursor.rebuilt === true) lines.push('your read position was lost and has been reset; some direct messages may repeat');
    return { text: lines.join('\n'), count: got.messages.length };
  }

  async who(): Promise<string> {
    const run = await currentRun(this.root);
    if (run === undefined) return 'no run yet';
    const { msgs } = runPaths(run);
    const rows = [['name', 'joined', 'last sent', 'unread']];
    for (const name of await listAgents(run)) {
      const cursor = await loadCursor(run, name);
      if (cursor === undefined) continue;
      const unread = await collect(msgs, cursor.offsets, isFor(name, cursor.joinedAt), UNLIMITED);
      const lastSent = (await readFrom(msgs, name, 0)).lines.at(-1)?.msg.ts;
      rows.push([name, hhmm(cursor.joinedAt), lastSent === undefined ? '-' : hhmm(lastSent), String(unread.messages.length)]);
    }
    return `run ${run.id}\n${table(rows)}`;
  }

  async stats(id?: string): Promise<string> {
    const run = id === undefined ? await currentRun(this.root) : await openRun(this.root, id);
    if (run === undefined) return 'no run yet';
    const { msgs } = runPaths(run);
    const rows = [['name', 'sent', 'inbox calls', 'delivered', 'chars', 'notices', '~tokens']];
    const totals = [0, 0, 0, 0, 0, 0];
    for (const name of await listAgents(run)) {
      const cursor = await loadCursor(run, name);
      if (cursor === undefined) continue;
      const sent = (await readFrom(msgs, name, 0)).lines.length;
      const { notices } = await loadNotified(run, name);
      const tokens = Math.ceil(cursor.stats.deliveredChars / 4) + notices * NOTICE_TOKENS;
      const values = [sent, cursor.stats.inboxCalls, cursor.stats.delivered, cursor.stats.deliveredChars, notices, tokens];
      values.forEach((value, i) => (totals[i] = (totals[i] ?? 0) + value));
      rows.push([name, ...values.map(String)]);
    }
    rows.push(['total', ...totals.map(String)]);
    return (
      `run ${run.id}\n${table(rows)}\n` +
      '~tokens counts message text and hook notices, not tool-call overhead; transcripts have the exact cost.'
    );
  }

  async newRun(label?: string): Promise<string> {
    return `started run ${(await newRun(this.root, label)).id}`;
  }

  async #run(): Promise<Run> {
    const run = await currentRun(this.root);
    if (run === undefined) throw new BoardError('no run yet; call join first');
    return run;
  }

  async #cursor(run: Run, name: string): Promise<Cursor & { rebuilt?: true }> {
    const cursor = await loadCursor(run, name);
    if (cursor === undefined) {
      throw new BoardError(`"${name}" has not joined run ${run.id}; call join first, with rejoin: true if you were ${name} before a /clear`);
    }
    return cursor;
  }
}

function parseRecipients(to: string | readonly string[], as: string): string[] {
  const list = (typeof to === 'string' ? to.split(',') : [...to]).map((r) => r.trim()).filter((r) => r !== '');
  if (list.length === 0) throw new BoardError('to is required: one or more names, or "all"');
  if (list.includes(ALL) && list.length > 1) throw new BoardError('send to "all" or to names, not both');
  for (const recipient of list) {
    if (recipient === ALL || recipient === HUMAN) continue;
    const problem = nameError(recipient);
    if (problem !== undefined) throw new BoardError(problem);
  }
  if (list.includes(as)) throw new BoardError('you cannot send a message to yourself');
  return [...new Set(list)];
}
