import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { BoardError, errorCode, isRecord } from '../board/fsutil.js';

export interface SetupResult {
  changes: string[];
  notes: string[];
}

/** Merge the Crosstalk server and hooks into a project's Claude Code config. Never overwrites what is there. */
export async function setupClaude(root: string, cliPath: string): Promise<SetupResult> {
  const mcpPath = join(root, '.mcp.json');
  const settingsPath = join(root, '.claude', 'settings.local.json');
  // Read both before writing either: half a setup is worse than none.
  const mcp = await readObject(mcpPath);
  const settings = await readObject(settingsPath);
  const cli = slashes(cliPath);
  const repo = slashes(root);

  const servers = isRecord(mcp['mcpServers']) ? { ...mcp['mcpServers'] } : {};
  servers['crosstalk'] = { command: 'node', args: [cli, 'mcp', '--repo', repo] };
  mcp['mcpServers'] = servers;

  const command = `node "${cli}" hook --repo "${repo}"`;
  const ours = `hook --repo "${repo}"`;
  const hooks = isRecord(settings['hooks']) ? { ...settings['hooks'] } : {};
  setHook(hooks, 'PostToolUse', command, ours, '*');
  setHook(hooks, 'Stop', command, ours);
  setHook(hooks, 'SubagentStop', command, ours);
  settings['hooks'] = hooks;

  await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const changes = [`mcp     ${mcpPath}: server "crosstalk"`, `hooks   ${settingsPath}: PostToolUse, Stop, SubagentStop`];
  const notes: string[] = [];
  const ignore = await ignoreState(root);
  if (ignore === 'added') changes.push('ignore  .git/info/exclude: .crosstalk/');
  if (ignore === 'no-git-dir') notes.push('No .git directory here. Add .crosstalk/ to your ignore list yourself.');
  if (await isTracked(root, '.mcp.json')) {
    notes.push('.mcp.json is tracked by git, and the crosstalk entry holds paths for this machine. Commit it only if everyone shares them.');
  }
  notes.push('Restart the Claude Code sessions in this folder so they load the server and the hooks.');
  return { changes, notes };
}

function setHook(hooks: Record<string, unknown>, event: string, command: string, ours: string, matcher?: string): void {
  const existing: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  // Drop an earlier Crosstalk hook for this repository, which may point at another checkout.
  const kept = existing.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        Array.isArray(entry['hooks']) &&
        entry['hooks'].some((hook) => isRecord(hook) && typeof hook['command'] === 'string' && hook['command'].endsWith(ours))
      ),
  );
  kept.push({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] });
  hooks[event] = kept;
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) throw new BoardError(`${path} is not a JSON object. Fix or remove it, then run setup again.`);
  return value;
}

async function ignoreState(root: string): Promise<'added' | 'present' | 'no-git-dir'> {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return 'no-git-dir';
  const path = join(gitDir, 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (current.split(/\r?\n/).includes('.crosstalk/')) return 'present';
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await appendFile(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}.crosstalk/\n`, 'utf8');
  return 'added';
}

function isTracked(root: string, file: string): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['ls-files', '--error-unmatch', file], { cwd: root }, (error) => done(error === null));
  });
}

function slashes(path: string): string {
  return path.split(sep).join('/');
}
