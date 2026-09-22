import { ALL } from './agents.js';
import { merge, readFrom, senders, type Line, type Message } from './messages.js';

export interface Limit {
  count: number;
  chars: number;
}

export const UNLIMITED: Limit = { count: Number.POSITIVE_INFINITY, chars: Number.POSITIVE_INFINITY };

export interface Collected {
  messages: Message[];
  /** Offsets to save: past everything delivered, and past skipped messages where nothing is held back. */
  next: Record<string, number>;
  /** Accepted messages held back by the limit. */
  more: number;
  corrupt: number;
}

/** Direct messages whenever they were sent; broadcasts only from the join on; never your own. */
export function isFor(name: string, joinedAt: string): (msg: Message) => boolean {
  return (msg) => msg.from !== name && (msg.to.includes(name) || (msg.to.includes(ALL) && msg.ts >= joinedAt));
}

export function isDirectFor(name: string): (msg: Message) => boolean {
  return (msg) => msg.from !== name && msg.to.includes(name);
}

export async function collect(
  msgsDir: string,
  from: Record<string, number>,
  accept: (msg: Message) => boolean,
  limit: Limit,
): Promise<Collected> {
  const queues = new Map<string, Line[]>();
  const ends = new Map<string, number>();
  let corrupt = 0;
  let total = 0;
  for (const sender of await senders(msgsDir)) {
    const chunk = await readFrom(msgsDir, sender, from[sender] ?? 0);
    const accepted = chunk.lines.filter((line) => accept(line.msg));
    queues.set(sender, accepted);
    ends.set(sender, chunk.end);
    corrupt += chunk.corrupt;
    total += accepted.length;
  }

  const messages: Message[] = [];
  const lastEnd = new Map<string, number>();
  const taken = new Map<string, number>();
  let chars = 0;
  for (const line of merge(queues)) {
    const size = line.msg.text.length;
    if (messages.length >= limit.count) break;
    if (messages.length > 0 && chars + size > limit.chars) break;
    messages.push(line.msg);
    chars += size;
    lastEnd.set(line.sender, line.end);
    taken.set(line.sender, (taken.get(line.sender) ?? 0) + 1);
  }

  const next: Record<string, number> = { ...from };
  for (const [sender, lines] of queues) {
    const all = (taken.get(sender) ?? 0) === lines.length;
    next[sender] = all ? (ends.get(sender) ?? 0) : (lastEnd.get(sender) ?? from[sender] ?? 0);
  }
  return { messages, next, more: total - messages.length, corrupt };
}
