#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CrosstalkEvent } from '../contracts/events.js';
import { doctor, type Finding } from '../harness/doctor.js';
import { loadConfig } from '../daemon/config.js';
import { startDaemon } from '../daemon/server.js';
import { resolveHubDist } from '../daemon/hub.js';
import { HUMAN_ID } from '../contracts/room.js';

import { CliError, DaemonClient, EXIT, stateDir, type WriteResult } from './client.js';
import { preflight, purgeWorkspaces, runInit } from './init.js';
import { openBrowser } from './open.js';
import { bold, dim, emit, eventLine, table } from './output.js';

const USAGE = `crosstalk — multi-agent development where a finding is a claim, not a command

  crosstalk init [--participant id:role:harness[:model]]... [--force]
  crosstalk up   [--port N] [--no-open] [--force]
  crosstalk down [--as <id>] [--purge]
  crosstalk doctor

  ct say      --as <id> --room '#floor' --body '...' [--to <id>]
  ct claim    --as <id> --against <id> --target <file:line> --assertion '...' --falsifier '...'
              [--severity blocker|defect|risk|nit] [--evidence-cmd '...'] [--evidence-sha <sha>]
  ct respond  <claim-id> --as <id> --verdict accept|contest|uphold|concede|amend|clarify
              [--rationale '...'] [--falsifier '...'] [--evidence-cmd '...'] [--evidence-sha <sha>]
  ct events   [--as <id>] [--since N]
  ct await    [--as <id>] [--timeout 50]
  ct roster | ct board | ct mine   [--as <id>]

Global: --repo <path> (default .), --json, --help
Token:  CROSSTALK_TOKEN, else .crosstalk/tokens/<id> via --as. URL: CROSSTALK_URL, else .crosstalk/daemon.json`;

type Flags = Record<string, string | boolean | string[] | undefined>;

const COMMON = {
  repo: { type: 'string' as const, default: '.' },
  as: { type: 'string' as const },
  json: { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, default: false },
};

function read(argv: string[], extra: ParseArgsConfig['options'] = {}): { flags: Flags; rest: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...COMMON, ...extra },
      allowPositionals: true,
      strict: true,
    });
    return { flags: values as Flags, rest: positionals };
  } catch (error) {
    throw new CliError((error as Error).message, EXIT.usage, 'Run `crosstalk --help` for the full surface.');
  }
}

const str = (flags: Flags, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

function require_(flags: Flags, name: string): string {
  const value = str(flags, name);
  if (value === undefined) {
    throw new CliError(`--${name} is required`, EXIT.usage, 'Run `crosstalk --help`.');
  }
  return value;
}

function evidenceFrom(flags: Flags): { kind: 'command'; command: string; output?: string; sha: string }[] {
  const command = str(flags, 'evidence-cmd');
  if (command === undefined) return [];
  const sha = str(flags, 'evidence-sha');
  if (sha === undefined) {
    throw new CliError(
      '--evidence-cmd needs --evidence-sha',
      EXIT.usage,
      'Evidence names the commit it ran at, or a reviewer cannot tell whether it still holds. Try --evidence-sha $(git rev-parse HEAD).',
    );
  }
  const output = str(flags, 'evidence-output');
  return [{ kind: 'command', command, ...(output === undefined ? {} : { output }), sha }];
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  switch (command) {
    case 'init':
      return await cmdInit(rest);
    case 'up':
      return await cmdUp(rest);
    case 'down':
      return await cmdDown(rest);
    case 'doctor':
      return await cmdDoctor(rest);
    case 'say':
      return await cmdSay(rest);
    case 'claim':
      return await cmdClaim(rest);
    case 'respond':
      return await cmdRespond(rest);
    case 'events':
      return await cmdEvents(rest);
    case 'await':
      return await cmdAwait(rest);
    case 'roster':
      return await cmdRoster(rest);
    case 'board':
      return await cmdBoard(rest);
    case 'mine':
      return await cmdMine(rest);
    default:
      throw new CliError(`Unknown command "${command}"`, EXIT.usage, 'Run `crosstalk --help` for the full surface.');
  }
}

async function cmdInit(argv: string[]): Promise<number> {
  const { flags } = read(argv, {
    participant: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
  });
  const repo = str(flags, 'repo') ?? '.';

  const result = await runInit({
    repo,
    participants: (flags['participant'] as string[] | undefined) ?? [],
    force: flags['force'] === true,
  });

  emit({ config: result.configPath, mcp: result.mcpPath, participants: result.kickoff }, flags['json'] === true, () => {
    const lines = [
      `${bold('Crosstalk initialised')} in ${resolve(repo)}`,
      '',
      `  crosstalk.yaml   ${result.configPath}`,
      `  .mcp.json        ${result.mcpPath}`,
      `  tokens           ${join(stateDir(repo), 'tokens')} (${result.tokens.size})`,
      '',
      bold('Paste one line into each agent:'),
      '',
      ...result.kickoff.flatMap((entry) => [`  ${bold(entry.id)}`, `    ${entry.line}`, '']),
      `Then: ${bold('crosstalk up')}`,
    ];
    return lines.join('\n');
  });
  return EXIT.ok;
}

async function cmdUp(argv: string[]): Promise<number> {
  const { flags } = read(argv, {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  });
  const repo = resolve(str(flags, 'repo') ?? '.');
  const portRaw = str(flags, 'port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && !Number.isInteger(port)) {
    throw new CliError('--port must be an integer', EXIT.usage);
  }

  const config = await loadConfig(repo);

  // Before anything binds. A rejected configuration that started anyway is
  // design §11's validation existing only on paper.
  const findings = await preflight(repo, flags['force'] === true);
  if (findings.length > 0) process.stdout.write(`${formatFindings(findings)}\n\n`);

  const daemon = await startDaemon({ repo, ...(port === undefined ? {} : { port }) });

  const humanToken = daemon.tokens.get(HUMAN_ID);
  const hubUrl = humanToken === undefined ? daemon.url : `${daemon.url}/?t=${humanToken}`;

  process.stdout.write(
    [
      `${bold('Crosstalk is up')}  ${daemon.url}`,
      dim(`  hub      ${resolveHubDist(import.meta.url)}`),
      dim(`  log      ${join(stateDir(repo), 'events.jsonl')}`),
      dim(`  agents   ${config.participants.map((p) => p.id).join(', ')}`),
      '',
      dim('  Ctrl-C to stop, or `crosstalk down` from another shell.'),
      '',
    ].join('\n'),
  );

  if (flags['no-open'] !== true && humanToken !== undefined) {
    // Never fatal: the daemon is serving whether or not a browser appeared.
    const opened = await openBrowser(hubUrl);
    if (!opened) process.stdout.write(dim(`  Open this yourself: ${hubUrl}\n`));
  } else if (humanToken !== undefined) {
    process.stdout.write(dim(`  Hub: ${hubUrl}\n`));
  }

  // Hold the process open; the listening socket does the rest.
  await new Promise<void>((done) => {
    const stop = (): void => {
      void daemon.close().then(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return EXIT.ok;
}

async function cmdDown(argv: string[]): Promise<number> {
  const { flags } = read(argv, { purge: { type: 'boolean', default: false } });
  const repo = resolve(str(flags, 'repo') ?? '.');

  let stopped = false;
  try {
    const client = await DaemonClient.open(repo, str(flags, 'as') ?? 'leader');
    await client.post('/shutdown', {});
    stopped = true;
  } catch (error) {
    // A daemon that is already gone is not a failure of `down`.
    if (!(error instanceof CliError) || error.exitCode !== EXIT.daemon) throw error;
  }

  // AGENTS.md rule 9: whatever gets created under .crosstalk/ has to be
  // findable and removable here.
  for (const file of ['daemon.json', 'daemon.lock']) {
    await rm(join(stateDir(repo), file), { force: true });
  }
  if (flags['purge'] === true) {
    // Before the tokens, because purging is driven from the config and a
    // half-removed worktree is harder to explain than a stale token.
    await purgeWorkspaces(repo);
    await rm(join(stateDir(repo), 'tokens'), { recursive: true, force: true });
  }

  emit({ stopped, purged: flags['purge'] === true }, flags['json'] === true, () =>
    [
      stopped ? 'Daemon stopped.' : 'No daemon was running.',
      'Removed daemon.json and daemon.lock.',
      flags['purge'] === true
        ? 'Purged tokens. `crosstalk up` will mint new ones — rerun `crosstalk init` to refresh .mcp.json.'
        : dim('The event log and tokens are kept. Use --purge to remove tokens too.'),
    ].join('\n'),
  );
  return EXIT.ok;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags } = read(argv);
  const repo = resolve(str(flags, 'repo') ?? '.');
  const findings = await doctor(await loadConfig(repo), repo);

  emit(findings, flags['json'] === true, () =>
    findings.length === 0 ? 'No findings. Everything doctor checks is in order.' : formatFindings(findings),
  );

  // Warnings never block: each one names a capability lost, not a fault.
  return findings.some((finding) => finding.level === 'reject') ? EXIT.protocol : EXIT.ok;
}

/** One rendering, so `up`'s preflight and `doctor` cannot drift apart. */
function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.level === 'reject' ? bold('REJECT') : 'warn  '}  ${finding.code}\n    ${finding.message}\n    ${dim(`remedy: ${finding.remedy}`)}`)
    .join('\n\n');
}

async function withClient<T>(argv: string[], extra: ParseArgsConfig['options'], fn: (client: DaemonClient, flags: Flags, rest: string[]) => Promise<T>): Promise<T> {
  const { flags, rest } = read(argv, extra);
  const repo = resolve(str(flags, 'repo') ?? '.');
  const client = await DaemonClient.open(repo, str(flags, 'as'));
  return fn(client, flags, rest);
}

async function cmdSay(argv: string[]): Promise<number> {
  return withClient(argv, { room: { type: 'string' }, body: { type: 'string' }, to: { type: 'string' } }, async (client, flags) => {
    const to = str(flags, 'to');
    const result = await client.post<WriteResult>('/events', {
      kind: 'message',
      room: require_(flags, 'room'),
      body: require_(flags, 'body'),
      ...(to === undefined ? {} : { to }),
    });
    emit(result, flags['json'] === true, () => `posted seq ${result.events[result.events.length - 1]!.seq}`);
    return EXIT.ok;
  });
}

async function cmdClaim(argv: string[]): Promise<number> {
  return withClient(
    argv,
    {
      against: { type: 'string' },
      target: { type: 'string' },
      assertion: { type: 'string' },
      body: { type: 'string' },
      falsifier: { type: 'string' },
      severity: { type: 'string', default: 'defect' },
      'evidence-cmd': { type: 'string' },
      'evidence-sha': { type: 'string' },
      'evidence-output': { type: 'string' },
      task: { type: 'string' },
    },
    async (client, flags) => {
      const task = str(flags, 'task');
      const result = await client.post<WriteResult>('/claims', {
        against: require_(flags, 'against'),
        target: require_(flags, 'target'),
        assertion: str(flags, 'assertion') ?? require_(flags, 'body'),
        severity: str(flags, 'severity') ?? 'defect',
        // Passed through even when empty: MISSING_FALSIFIER is a protocol
        // refusal the agent is meant to see, not a usage error from here.
        falsifier: str(flags, 'falsifier') ?? '',
        evidence: evidenceFrom(flags),
        ...(task === undefined ? {} : { taskId: task }),
      });
      const raised = result.events.find((event) => event.kind === 'claim_raised');
      emit(result, flags['json'] === true, () =>
        raised?.kind === 'claim_raised' ? `raised ${bold(raised.claim.id)} against ${raised.claim.against}` : 'raised',
      );
      return EXIT.ok;
    },
  );
}

async function cmdRespond(argv: string[]): Promise<number> {
  return withClient(
    argv,
    {
      verdict: { type: 'string' },
      rationale: { type: 'string' },
      falsifier: { type: 'string' },
      'evidence-cmd': { type: 'string' },
      'evidence-sha': { type: 'string' },
      'evidence-output': { type: 'string' },
    },
    async (client, flags, rest) => {
      const claimId = rest[0];
      if (claimId === undefined) {
        throw new CliError('a claim id is required', EXIT.usage, 'For example: ct respond C-118 --verdict contest ...');
      }
      const rationale = str(flags, 'rationale');
      const falsifier = str(flags, 'falsifier');
      const result = await client.post<WriteResult>(`/claims/${encodeURIComponent(claimId)}/response`, {
        verdict: require_(flags, 'verdict'),
        evidence: evidenceFrom(flags),
        ...(rationale === undefined ? {} : { rationale }),
        ...(falsifier === undefined ? {} : { falsifier }),
      });
      emit(result, flags['json'] === true, () => `responded to ${claimId}`);
      return EXIT.ok;
    },
  );
}

async function cmdEvents(argv: string[]): Promise<number> {
  return withClient(argv, { since: { type: 'string', default: '0' } }, async (client, flags) => {
    const since = Number(str(flags, 'since') ?? '0');
    if (!Number.isInteger(since) || since < 0) {
      throw new CliError('--since must be a non-negative integer', EXIT.usage);
    }
    const result = await client.get<{ events: CrosstalkEvent[]; lastSeq: number }>(`/events?since=${since}`);
    emit(result, flags['json'] === true, () => table(result.events.map(eventLine)));
    return EXIT.ok;
  });
}

async function cmdAwait(argv: string[]): Promise<number> {
  return withClient(argv, { timeout: { type: 'string', default: '50' } }, async (client, flags) => {
    const timeout = Number(str(flags, 'timeout') ?? '50');
    if (!Number.isInteger(timeout) || timeout < 0) {
      throw new CliError('--timeout must be a non-negative integer', EXIT.usage);
    }
    const result = await client.get<{ events?: CrosstalkEvent[]; idle?: boolean }>(`/await?timeout_s=${timeout}`);
    emit(result, flags['json'] === true, () =>
      result.idle === true ? 'idle' : table((result.events ?? []).map(eventLine)),
    );
    return EXIT.ok;
  });
}

async function cmdRoster(argv: string[]): Promise<number> {
  return withClient(argv, {}, async (client, flags) => {
    const result = await client.get<{ participants: Record<string, string>[] }>('/roster');
    emit(result, flags['json'] === true, () =>
      table(result.participants.map((p) => [p['id']!, p['role']!, p['harness']!, p['model'] ?? '', p['status']!])),
    );
    return EXIT.ok;
  });
}

async function cmdBoard(argv: string[]): Promise<number> {
  return withClient(argv, {}, async (client, flags) => {
    const result = await client.get<{ tasks: Record<string, string>[] }>('/board');
    emit(result, flags['json'] === true, () =>
      table(result.tasks.map((t) => [t['id']!, t['state']!, t['assignee']!, t['title']!])),
    );
    return EXIT.ok;
  });
}

async function cmdMine(argv: string[]): Promise<number> {
  return withClient(argv, {}, async (client, flags) => {
    const result = await client.get<{ tasks: Record<string, string>[] }>('/tasks/mine');
    emit(result, flags['json'] === true, () =>
      table(result.tasks.map((t) => [t['id']!, t['state']!, t['branch']!, t['title']!])),
    );
    return EXIT.ok;
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      // Every failure message names the remedy, not just the condition.
      if (error.remedy !== undefined) process.stderr.write(`${error.remedy}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT.daemon;
  });
