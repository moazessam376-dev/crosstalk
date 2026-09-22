import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadCursor, loadNotified, saveNotified } from '../board/agents.js';
import { errorCode, writeAtomic } from '../board/fsutil.js';
import { UNLIMITED, collect, isDirectFor, isFor } from '../board/inbox.js';
import { currentRun, runPaths, type Run } from '../board/runs.js';

/** The fields of Claude Code's hook input that the board uses. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  /** Present only inside a subagent. */
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  cwd?: string;
}

export type HookOutput =
  | { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } }
  | { decision: 'block'; reason: string };

const JOIN_TOOL = /^mcp__crosstalk[\w-]*__join$/;
const INBOX_TOOL = /^mcp__crosstalk[\w-]*__inbox$/;

/**
 * Tells an agent it has mail; never passes the mail itself. Agents treat
 * message text arriving through a hook as possible prompt injection and will
 * not act on it, but they act on messages they fetched with their own inbox call.
 */
export async function runHook(root: string, input: HookInput): Promise<HookOutput | undefined> {
  const key = hookKey(input);
  if (key === undefined) return undefined;
  const run = await currentRun(root);
  if (run === undefined) return undefined;
  const event = input.hook_event_name;
  const tool = input.tool_name ?? '';

  if (event === 'PostToolUse' && JOIN_TOOL.test(tool)) {
    await remember(run, key, input);
    return undefined;
  }

  const name = await recall(run, key);
  if (name === undefined) return undefined;
  const cursor = await loadCursor(run, name);
  if (cursor === undefined) return undefined;
  const { msgs } = runPaths(run);

  if (event === 'PostToolUse') {
    if (INBOX_TOOL.test(tool)) return undefined;
    const notified = await loadNotified(run, name);
    const from = furthest(cursor.offsets, notified.offsets);
    const got = await collect(msgs, from, isFor(name, cursor.joinedAt), UNLIMITED);
    if (got.messages.length === 0) return undefined;
    await saveNotified(run, name, { offsets: got.next, notices: notified.notices + 1 });
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `crosstalk: ${unread(got.messages.length)} for ${name}. Call inbox.`,
      },
    };
  }

  if ((event === 'Stop' || event === 'SubagentStop') && input.stop_hook_active !== true) {
    const got = await collect(msgs, cursor.offsets, isDirectFor(name), UNLIMITED);
    if (got.messages.length === 0) return undefined;
    return { decision: 'block', reason: `crosstalk: ${unread(got.messages.length)} for ${name}. Call inbox before finishing.` };
  }

  return undefined;
}

/** A subagent is known only by its own id, never by the session it shares with its parent. */
function hookKey(input: HookInput): string | undefined {
  const raw = input.agent_id ?? (input.session_id === undefined ? undefined : `s-${input.session_id}`);
  return raw?.replace(/[^A-Za-z0-9-]/g, '_');
}

async function remember(run: Run, key: string, input: HookInput): Promise<void> {
  const name = input.tool_input?.['name'];
  if (typeof name !== 'string') return;
  if (!JSON.stringify(input.tool_response ?? '').includes(`joined as ${name}`)) return;
  await writeAtomic(join(runPaths(run).hooks, key), name);
}

async function recall(run: Run, key: string): Promise<string | undefined> {
  try {
    return (await readFile(join(runPaths(run).hooks, key), 'utf8')).trim() || undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function furthest(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [sender, offset] of Object.entries(b)) out[sender] = Math.max(out[sender] ?? 0, offset);
  return out;
}

function unread(n: number): string {
  return `${n} unread message${n === 1 ? '' : 's'}`;
}
