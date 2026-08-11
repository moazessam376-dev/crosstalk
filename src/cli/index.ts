#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CrosstalkEvent } from '../contracts/events.js';
import { doctor, type Finding } from '../harness/doctor.js';
import { runningCliPath } from '../harness/install.js';
import { loadConfig } from '../daemon/config.js';
import { startDaemon, tokenFilename } from '../daemon/server.js';
import { resolveHubDist } from '../daemon/hub.js';
import { HUMAN_ID } from '../contracts/room.js';

import { CliError, DaemonClient, EXIT, stateDir, type WriteResult } from './client.js';
import { preflight, purgeWorkspaces, runInit } from './init.js';
import { openBrowser } from './open.js';
import { bold, dim, emit, eventLine, failureText, table } from './output.js';

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

  ct task create --as <leader> --id T-01 --title '...' --brief '...'
                 --assignee <id> --branch <branch>
                 [--spec-ref R]... [--dep T-00]... [--acceptance '...']...
  ct task state <id> --as <id> --state <state> [--reason '...']

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

  const handler = HANDLERS[command];
  if (handler === undefined) {
    throw new CliError(`Unknown command "${command}"`, EXIT.usage, 'Run `crosstalk --help` for the full surface.');
  }
  return await handler(rest);
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

  emit({ config: result.configPath, mcp: result.mcp, participants: result.kickoff }, flags['json'] === true, () => {
    const written = result.mcp.filter((entry) => entry.written);
    const manual = result.mcp.filter((entry) => !entry.written);
    const lines = [
      `${bold('Crosstalk initialised')} in ${resolve(repo)}`,
      '',
      `  crosstalk.yaml   ${result.configPath}`,
      ...written.map((entry) => `  mcp ${entry.participantId.padEnd(12)} ${entry.path}`),
      `  tokens           ${join(stateDir(repo), 'tokens')} (${result.tokens.size})`,
      '',
      // Named, never silent: a participant Crosstalk could not register has to
      // be told to the user, or the agent falls back to the CLI and nobody
      // knows why.
      ...(manual.length === 0
        ? []
        : [
            bold('Add these by hand — Crosstalk did not write them:'),
            '',
            ...manual.flatMap((entry) => [
              `  ${bold(entry.participantId)}  ${dim(entry.reason ?? '')}`,
              ...JSON.stringify({ mcpServers: { crosstalk: entry.entry } }, null, 2).split('\n').map((line) => `    ${line}`),
              '',
            ]),
          ]),
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
  const hubUrl = humanToken === undefined ? undefined : `${daemon.url}/?t=${humanToken}`;

  // A terminal is what makes opening a browser meaningful. `rundll32` exits zero
  // on a headless launch having opened nothing, so attempting it there reports a
  // success that did not happen.
  const browser =
    flags['no-open'] === true || hubUrl === undefined
      ? 'disabled'
      : process.stdout.isTTY === true
        ? 'opening'
        : 'no-tty';

  process.stdout.write(
    `${upBanner({
      url: daemon.url,
      hubUrl,
      cli: runningCliPath(),
      hub: resolveHubDist(import.meta.url),
      log: join(stateDir(repo), 'events.jsonl'),
      agents: config.participants.map((participant) => participant.id),
      browser,
    }).join('\n')}\n`,
  );

  if (browser === 'opening') {
    // Never fatal: the daemon is serving whether or not a browser appeared, and
    // the url is already on screen either way.
    await openBrowser(hubUrl!);
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

/**
 * The `up` banner, as data.
 *
 * CT-11: the tokenised hub URL is the only way in — the daemon refuses a
 * browser without it, and a refused hub renders as a quiet one (CT-10) — and it
 * was printed on exactly one branch, the `--no-open` one. On the default path
 * the line never appeared, so an operator who lost the scrollback had no way
 * back to their own hub, and the origin a browser autocompletes is the
 * untokenised one that gets refused.
 *
 * Returned rather than written so a test can assert the line is present on
 * every branch. That is the whole invariant, and it is not one an eyeball on a
 * banner reliably checks.
 */
export function upBanner(parts: {
  url: string;
  /** Absent only when there is no `@human` token to embed. */
  hubUrl?: string;
  cli: string;
  hub: string;
  log: string;
  agents: readonly string[];
  browser: 'opening' | 'no-tty' | 'disabled';
}): string[] {
  return [
    `${bold('Crosstalk is up')}  ${parts.url}`,
    // CT-1: which build this actually is. `ct` on PATH can be a different
    // checkout, and every symptom of that skew looks like a protocol bug until
    // you know the two are not the same code.
    dim(`  cli      ${parts.cli}`),
    dim(`  hub      ${parts.hub}`),
    dim(`  log      ${parts.log}`),
    dim(`  agents   ${parts.agents.join(', ')}`),
    '',
    ...(parts.hubUrl === undefined ? [] : [`  ${bold('Hub:')} ${parts.hubUrl}`]),
    ...(parts.browser === 'no-tty'
      ? [dim('  No terminal here, so no browser was opened. Open the line above.')]
      : []),
    '',
    dim('  Ctrl-C to stop, or `crosstalk down` from another shell.'),
    '',
  ];
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

  // CT-11's other half: the tokenised hub URL is recoverable without scrollback.
  // `up` prints it once; if that window is gone, this is the only other place it
  // exists, and the untokenised origin a browser autocompletes gets refused.
  const hubUrl = await runningHubUrl(repo);

  emit(findings, flags['json'] === true, () =>
    [
      findings.length === 0 ? 'No findings. Everything doctor checks is in order.' : formatFindings(findings),
      ...(hubUrl === undefined ? [] : ['', `${bold('Hub:')} ${hubUrl}`]),
    ].join('\n'),
  );

  // Warnings never block: each one names a capability lost, not a fault.
  return findings.some((finding) => finding.level === 'reject') ? EXIT.protocol : EXIT.ok;
}

/**
 * The tokenised hub url for a daemon that is currently running, or `undefined`.
 *
 * Two files, because they hold different halves and always have: `daemon.json`
 * is `{version, url, pid, startedAt}` and has never carried a token, and the
 * token lives at `.crosstalk/tokens/human` — `tokenFilename` strips the `@`.
 * Silent when either is missing: no daemon, or no human token, is an ordinary
 * state and not something `doctor` should report as a fault.
 */
async function runningHubUrl(repo: string): Promise<string | undefined> {
  try {
    const descriptor = JSON.parse(await readFile(join(stateDir(repo), 'daemon.json'), 'utf8')) as { url?: string };
    if (typeof descriptor.url !== 'string') return undefined;
    const token = (await readFile(join(stateDir(repo), 'tokens', tokenFilename(HUMAN_ID)), 'utf8')).trim();
    return token === '' ? undefined : `${descriptor.url}/?t=${token}`;
  } catch {
    return undefined;
  }
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

/**
 * `ct task create` and `ct task state`. CT-14b.
 *
 * One `HANDLERS` key with a sub-dispatch, not two. `main` looks up `argv[0]`
 * alone, so a key of `'task create'` is unreachable — and
 * `tests/harness/brief-vocabulary.test.ts` extracts only the first word after
 * `` `crosstalk ``, so two keys would make the command table and the brief
 * disagree about a command that does exist.
 *
 * The daemon owns every rule here: who may create a task (`requireRole`), which
 * transitions are legal (`validateTransition`), whether the gates have been
 * passed. Duplicating any of that in the CLI would give an agent two different
 * answers to the same question, and the daemon's refusals are the ones agents
 * have to learn to read.
 */
async function cmdTask(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === 'create') return cmdTaskCreate(argv.slice(1));
  if (subcommand === 'state') return cmdTaskState(argv.slice(1));

  throw new CliError(
    subcommand === undefined ? 'ct task needs a subcommand' : `Unknown task subcommand "${subcommand}"`,
    EXIT.usage,
    "Use `ct task create` to assign work, or `ct task state <id> --state <state>` to move it. Run `crosstalk --help` for the arguments.",
  );
}

async function cmdTaskCreate(argv: string[]): Promise<number> {
  return withClient(
    argv,
    {
      id: { type: 'string' },
      title: { type: 'string' },
      brief: { type: 'string' },
      assignee: { type: 'string' },
      branch: { type: 'string' },
      'spec-ref': { type: 'string', multiple: true },
      dep: { type: 'string', multiple: true },
      acceptance: { type: 'string', multiple: true },
    },
    async (client, flags) => {
      const result = await client.post<WriteResult>('/tasks', {
        id: require_(flags, 'id'),
        title: require_(flags, 'title'),
        brief: require_(flags, 'brief'),
        assignee: require_(flags, 'assignee'),
        branch: require_(flags, 'branch'),
        specRefs: (flags['spec-ref'] as string[] | undefined) ?? [],
        deps: (flags['dep'] as string[] | undefined) ?? [],
        acceptance: (flags['acceptance'] as string[] | undefined) ?? [],
      });
      const created = result.events.find((event) => event.kind === 'task_created');
      emit(result, flags['json'] === true, () =>
        created?.kind === 'task_created'
          ? `created ${bold(created.task.id)} for ${created.task.assignee} on ${created.task.branch}`
          : 'created',
      );
      return EXIT.ok;
    },
  );
}

async function cmdTaskState(argv: string[]): Promise<number> {
  return withClient(
    argv,
    { state: { type: 'string' }, reason: { type: 'string' } },
    async (client, flags, rest) => {
      const taskId = rest[0];
      if (taskId === undefined) {
        throw new CliError('a task id is required', EXIT.usage, 'For example: ct task state T-01 --state in_progress');
      }
      const reason = str(flags, 'reason');
      const state = require_(flags, 'state');
      const result = await client.post<WriteResult>(`/tasks/${encodeURIComponent(taskId)}/state`, {
        state,
        ...(reason === undefined ? {} : { reason }),
      });
      emit(result, flags['json'] === true, () => `${taskId} -> ${state}`);
      return EXIT.ok;
    },
  );
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

/**
 * The command surface, as data.
 *
 * A `switch` listed these names in one place and the briefs listed them in
 * another, and the two disagreed for the entire life of the project: the worker
 * brief told agents to run `crosstalk acknowledge` and `crosstalk submit`,
 * neither of which has ever existed. Exported so a test can compare the brief
 * against the real table instead of a second hand-written copy.
 */
const HANDLERS: Record<string, (argv: string[]) => Promise<number>> = {
  init: cmdInit,
  up: cmdUp,
  down: cmdDown,
  doctor: cmdDoctor,
  say: cmdSay,
  claim: cmdClaim,
  respond: cmdRespond,
  events: cmdEvents,
  await: cmdAwait,
  roster: cmdRoster,
  board: cmdBoard,
  mine: cmdMine,
  task: cmdTask,
};

export const CLI_COMMANDS: readonly string[] = Object.keys(HANDLERS);

/**
 * Is this module the program being run, rather than something imported?
 *
 * Both sides go through `realpath` first, and that is the whole point.
 * `import.meta.url` is already canonical; `process.argv[1]` is whatever path
 * the user typed. `npm link` — which is how the README tells people to get
 * `crosstalk` and `ct` on PATH — puts a link on PATH, so the two spellings
 * differ, a lexical comparison returns false, and the CLI exits 0 having done
 * nothing at all.
 *
 * Silently disabling the PATH binary would be bad anywhere. Inside the change
 * that fixes `ct` on PATH resolving to the wrong build (CT-1) it would be
 * indistinguishable from the bug being fixed.
 *
 * No test can catch it: every test here invokes `node dist/cli/index.js` by its
 * real path, which is the branch that passes either way. Verified by hand
 * through a junction instead.
 */
function invokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;

  const self = fileURLToPath(import.meta.url);
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      // Not on disk under that spelling; the lexical form is all there is.
      return resolve(path);
    }
  };

  const [a, b] = [canonical(invoked), canonical(self)];
  return process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(failureText(error));
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT.daemon;
  });
}
