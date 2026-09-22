import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { runHook, type HookInput } from '../../src/hooks/hook.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const SESSION = 'b1c2d3e4-0000-4000-8000-000000000000';
const SUB = 'ac3aab5d43df49e5c';

/** What Claude Code sends after a successful join tool call. */
function joined(name: string, agentId?: string, response = `joined as ${name} (run x)`): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    tool_name: 'mcp__crosstalk__join',
    tool_input: { name },
    tool_response: [{ type: 'text', text: response }],
  };
}

function toolCall(agentId?: string, tool = 'Bash'): HookInput {
  return { hook_event_name: 'PostToolUse', session_id: SESSION, ...(agentId === undefined ? {} : { agent_id: agentId }), tool_name: tool };
}

async function setup(): Promise<{ root: string; board: Board }> {
  const root = await tempRepo();
  const board = new Board(root);
  await board.join('orchestrator');
  await board.join('builder-1');
  return { root, board };
}

describe('PostToolUse', () => {
  it('stays quiet for an agent that never joined', async () => {
    const { root, board } = await setup();
    await board.send('orchestrator', 'builder-1', 'hello');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('announces unread messages once, by count, without their content', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'skip step two');
    const notice = await runHook(root, toolCall(SUB));
    expect(notice).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'crosstalk: 1 unread message for builder-1. Call inbox.',
      },
    });
    expect(JSON.stringify(notice)).not.toContain('skip step two');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('counts only messages that arrived since the last notice or read', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'one');
    await runHook(root, toolCall(SUB));
    await board.inbox('builder-1');
    await board.send('orchestrator', 'builder-1', 'two');
    await board.send('orchestrator', 'builder-1', 'three');
    const notice = await runHook(root, toolCall(SUB));
    expect(JSON.stringify(notice)).toContain('2 unread messages for builder-1');
  });

  it('says nothing after the inbox call itself', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'x');
    expect(await runHook(root, toolCall(SUB, 'mcp__crosstalk__inbox'))).toBeUndefined();
  });

  it('does not map a failed join', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB, 'name "builder-1" is taken'));
    await board.send('orchestrator', 'builder-1', 'x');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('never lets a subagent inherit its parent’s name', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('orchestrator'));
    await board.send('builder-1', 'orchestrator', 'for the parent');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
    expect(JSON.stringify(await runHook(root, toolCall()))).toContain('for orchestrator');
  });
});

describe('Stop and SubagentStop', () => {
  it('blocks finishing while a direct message is unread', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'one more thing');
    expect(await runHook(root, { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB })).toEqual({
      decision: 'block',
      reason: 'crosstalk: 1 unread message for builder-1. Call inbox before finishing.',
    });
  });

  it('lets it finish on the second attempt, and for broadcasts only', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'x');
    const again = { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB, stop_hook_active: true };
    expect(await runHook(root, again)).toBeUndefined();
    await board.inbox('builder-1');
    await board.send('orchestrator', 'all', 'fyi');
    expect(await runHook(root, { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB })).toBeUndefined();
  });

  it('applies to the main session’s Stop as well', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('orchestrator'));
    await board.send('builder-1', 'orchestrator', 'done with the dock');
    const result = await runHook(root, { hook_event_name: 'Stop', session_id: SESSION });
    expect(result).toMatchObject({ decision: 'block' });
  });
});
