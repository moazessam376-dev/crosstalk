import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { setupClaude } from '../../src/cli/setup.js';
import { BoardError } from '../../src/board/fsutil.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const CLI = '/opt/crosstalk/dist/cli/index.js';

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

describe('setupClaude', () => {
  it('writes the server, three hooks and the ignore line', async () => {
    const root = await tempRepo();
    await setupClaude(root, CLI);
    const mcp = await json(join(root, '.mcp.json'));
    expect(mcp.mcpServers.crosstalk.command).toBe('node');
    expect(mcp.mcpServers.crosstalk.args.slice(0, 3)).toEqual([CLI, 'mcp', '--repo']);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'Stop', 'SubagentStop']);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*');
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^node ".+index\.js" hook --repo ".+"$/);
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.crosstalk/');
  });

  it('keeps what the project already has', async () => {
    const root = await tempRepo();
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } }, extra: 1 }));
    await mkdir(join(root, '.claude'));
    const mine = { matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] };
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [mine] }, model: 'x' }));
    await setupClaude(root, CLI);
    const mcp = await json(join(root, '.mcp.json'));
    expect(mcp.mcpServers.playwright).toEqual({ command: 'npx' });
    expect(mcp.extra).toBe(1);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(settings.model).toBe('x');
    expect(settings.hooks.PostToolUse[0]).toEqual(mine);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });

  it('can run twice without duplicating anything', async () => {
    const root = await tempRepo();
    await setupClaude(root, CLI);
    await setupClaude(root, CLI);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    for (const event of ['PostToolUse', 'Stop', 'SubagentStop']) expect(settings.hooks[event]).toHaveLength(1);
    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.crosstalk/')).toHaveLength(1);
  });

  it('replaces its own hook when the checkout moves', async () => {
    const root = await tempRepo();
    await setupClaude(root, '/old/place/dist/cli/index.js');
    await setupClaude(root, CLI);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(CLI);
  });

  it('keeps project hooks that share an entry with its old one', async () => {
    const root = await tempRepo();
    await setupClaude(root, '/old/place/dist/cli/index.js');
    const path = join(root, '.claude', 'settings.local.json');
    const before = await json(path);
    before.hooks.PostToolUse[0].hooks.unshift({ type: 'command', command: 'npm run lint' });
    await writeFile(path, JSON.stringify(before));
    await setupClaude(root, CLI);
    const commands = (await json(path)).hooks.PostToolUse.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe('npm run lint');
    expect(commands[1]).toContain(CLI);
  });

  it('refuses a broken .mcp.json before writing anything', async () => {
    const root = await tempRepo();
    await writeFile(join(root, '.mcp.json'), '{ oops');
    await expect(setupClaude(root, CLI)).rejects.toThrow(BoardError);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe('{ oops');
  });
});
