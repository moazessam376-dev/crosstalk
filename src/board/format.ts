import { ALL } from './agents.js';
import type { Message } from './messages.js';

const pad = (n: number): string => String(n).padStart(2, '0');

export function hhmm(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `21:04 orchestrator: text`, naming the audience only when it is not just you. */
export function formatLine(msg: Message): string {
  const audience = msg.to.includes(ALL) ? ' → all' : msg.to.length > 1 ? ` → ${msg.to.join(', ')}` : '';
  return `${hhmm(msg.ts)} ${msg.from}${audience}: ${msg.text}`;
}

export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '))
    .join('\n');
}
