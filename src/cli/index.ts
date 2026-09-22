#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { Board } from '../board/board.js';
import { BoardError } from '../board/fsutil.js';
import { findRoot } from '../board/runs.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin(): Promise<string>;
}

export const EXIT = { ok: 0, error: 1, usage: 2, empty: 3 } as const;

const USAGE = `Usage: ct <command> [--repo <path>]

  join <name> [--rejoin]                    join the current run
  send --as <name> --to <names|all> <text>  send a message
  inbox --as <name> [--wait <seconds>]      read new messages; exit 3 if none
  who                                       who is in the current run
  new [label]                               start a new, empty run
  stats [run]                               what the board cost each agent
  hub [--port <n>] [--host <addr>]          serve the web hub
  setup claude                              install the Claude Code adapter
  mcp                                       run the MCP server on stdio
  hook                                      Claude Code hook entry point (reads stdin)`;

class UsageError extends Error {}

type Values = Record<string, unknown>;

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'join':
        return await join(rest, io);
      case 'send':
        return await send(rest, io);
      case 'inbox':
        return await inbox(rest, io);
      case 'who':
        return await simple(rest, io, (board) => board.who());
      case 'new':
        return await simple(rest, io, (board, positionals) => board.newRun(positionals[0]));
      case 'stats':
        return await simple(rest, io, (board, positionals) => board.stats(positionals[0]));
      case 'mcp':
        return await mcp(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return EXIT.ok;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof BoardError) {
      io.err(error.message);
      return EXIT.error;
    }
    throw error;
  }
}

function parse(args: string[], options: NonNullable<ParseArgsConfig['options']>): { values: Values; positionals: string[] } {
  try {
    return parseArgs({ args, options: { ...options, repo: { type: 'string' } }, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function rootOf(values: Values): string {
  const repo = values['repo'];
  return typeof repo === 'string' ? resolve(repo) : findRoot(process.cwd());
}

function need(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${key} is required`);
  return value;
}

async function join(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { rejoin: { type: 'boolean' } });
  const name = positionals[0];
  if (name === undefined) throw new UsageError('join needs a name');
  io.out(await new Board(rootOf(values)).join(name, values['rejoin'] === true));
  return EXIT.ok;
}

async function send(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { as: { type: 'string' }, to: { type: 'string' } });
  io.out(await new Board(rootOf(values)).send(need(values, 'as'), need(values, 'to'), positionals.join(' ')));
  return EXIT.ok;
}

async function inbox(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { as: { type: 'string' }, wait: { type: 'string' } });
  const wait = values['wait'] === undefined ? 0 : Number(values['wait']);
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError('--wait must be a number of seconds');
  const result = await new Board(rootOf(values)).inbox(need(values, 'as'), wait);
  io.out(result.text);
  return result.count === 0 ? EXIT.empty : EXIT.ok;
}

async function simple(
  args: string[],
  io: Io,
  action: (board: Board, positionals: string[]) => Promise<string>,
): Promise<number> {
  const { values, positionals } = parse(args, {});
  io.out(await action(new Board(rootOf(values)), positionals));
  return EXIT.ok;
}

async function mcp(args: string[]): Promise<number> {
  const { values } = parse(args, {});
  // Loaded here so every other command, the hook above all, starts without the SDK.
  const { serveStdio } = await import('../mcp/server.js');
  await serveStdio(new Board(rootOf(values)));
  return EXIT.ok;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(realpathSync(invoked)).href) {
  const io: Io = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdin: readStdin,
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
