import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import type { Participant } from '../contracts/participant.js';
import { loadConfig } from '../daemon/config.js';
import { loadRegistry, type HarnessDescriptor } from '../harness/registry.js';
import { probeCliHarnesses, type PathProbe } from '../harness/path.js';
import { boardTurn, driveSupervised, spawnSupervised, type ExecFile } from '../harness/runner.js';
import { openSession, type SpawnProcess } from '../harness/session.js';
import type { SessionRegistry } from '../harness/sessions.js';
import type { SpawnPty } from '../harness/pty.js';
import { trustWorkspaces } from '../harness/trust.js';
import type { Inbox } from '../core/inbox.js';
import { CliError, DaemonClient, EXIT, type WriteResult } from './client.js';
import { runInit } from './init.js';

export interface ComposeOptions {
  repo: string;
  job: string;
  participants: string[];
  force?: boolean;
  /** The team shape to brief seats with, e.g. `trio-contract`. */
  shape?: string;
  /** Set false in tests: skips writing folder trust to the operator's config. */
  trust?: boolean;
  /** Injected in tests. */
  spawn?: (argv: string[], cwd: string) => void;
  execFile?: ExecFile;
  postJob?: (repo: string, job: string) => Promise<void>;
  /** Injected in tests, so supervision can be driven without a real binary. */
  spawnProcess?: SpawnProcess;
  /** The same seam for interactive seats, which run on a pty rather than a pipe. */
  spawnPty?: SpawnPty;
  /**
   * Where to publish each opened session, so something can mirror it.
   *
   * The daemon passes its own; the CLI passes nothing, because nobody is
   * watching a `compose` run from a terminal through a browser. Absent, no
   * screen is reconstructed and the seats cost exactly what they did before
   * mirroring existed.
   */
  sessions?: SessionRegistry;
}

export interface ComposeResult {
  spawned: string[];
  attached: string[];
  posted: boolean;
  harnesses: PathProbe[];
  /** Seats that take a pushed turn, and so never sit in a poll loop. */
  supervised: string[];
  /**
   * Runs the wake loops until every supervised seat exits. Returned rather than
   * awaited so `runCompose` stays a function that returns: only the CLI, which
   * owns the process lifetime, decides to block on it.
   */
  supervise: () => Promise<void>;
}

export function selectSpawnTargets(
  participants: readonly Participant[],
  registry: Map<string, HarnessDescriptor>,
): { spawn: Participant[]; attach: Participant[] } {
  const spawn: Participant[] = [];
  const attach: Participant[] = [];
  for (const participant of participants) {
    if (participant.id === HUMAN_ID || participant.role === 'human') continue;
    const descriptor = registry.get(participant.harness);
    if (descriptor?.supervisable === true && descriptor.spawn !== undefined && participant.lifecycle === 'supervised') {
      spawn.push(participant);
    } else {
      attach.push(participant);
    }
  }
  return { spawn, attach };
}

export async function runCompose(options: ComposeOptions): Promise<ComposeResult> {
  const repo = resolve(options.repo);
  const job = options.job.trim();
  if (job === '') {
    throw new CliError('compose needs a job', EXIT.usage, 'Pass --job with the work the leader should cut.');
  }

  if (options.participants.length > 0) {
    requireSomeoneToWork(options.participants.map((spec) => spec.split(':')[1]));
    await runInit({
      repo,
      participants: options.participants,
      ...(options.shape === undefined ? {} : { shape: options.shape }),
      force: options.force === true,
    });
  }

  await markSupervised(repo);
  const config = await loadConfig(repo);
  requireSomeoneToWork(config.participants.map((participant) => participant.role));

  const registry = await loadRegistry();
  const { spawn, attach } = selectSpawnTargets(config.participants, registry);
  const harnesses = await probeCliHarnesses();

  // Trust before spawn, never after. An interactive seat opening a worktree
  // `init` made minutes ago stops on "Is this a project you trust?" and waits
  // forever; by the time anyone notices, the run is hours old. A seat that has
  // already stalled cannot be rescued by a later write to the config.
  const interactive = spawn.filter((p) => registry.get(p.harness)?.turnFormat === 'interactive');
  if (interactive.length > 0 && options.trust !== false) {
    await trustWorkspaces(interactive.map((p) => resolve(repo, p.workspace)));
  }

  if (options.postJob !== undefined) {
    await options.postJob(repo, job);
  } else {
    const client = await DaemonClient.open(repo, HUMAN_ID);
    await client.post<WriteResult>('/events', { kind: 'message', room: '#floor', body: job });
  }

  const spawned: string[] = [];
  const supervised: string[] = [];
  const loops: Array<() => Promise<void>> = [];

  for (const participant of spawn) {
    const descriptor = registry.get(participant.harness);
    const argv = descriptor?.spawn;
    if (argv === undefined) continue;
    const cwd = resolve(repo, participant.workspace);

    // The injected spawn is the test seam and stays a fire-and-forget call.
    if (options.spawn !== undefined) {
      options.spawn([...argv, job], cwd);
      spawned.push(participant.id);
      continue;
    }

    if (descriptor?.turnFormat === undefined) {
      // No way in after start. Spawn it with the job as its prompt and let it
      // pull — better than pretending every harness can be woken.
      spawnSupervised({ argv: [...argv, job], cwd, execFile: options.execFile });
      spawned.push(participant.id);
      continue;
    }

    const seatArgv = withFreshSession(withSeatModel(nameRemoteControl(argv, participant.id), participant));
    const session = openSession({
      argv: seatArgv,
      cwd,
      first: job,
      turnFormat: descriptor.turnFormat,
      // A seat that never got its job is indistinguishable, from the board,
      // from a seat ignoring the room. Say which it is — on the seat's own
      // presence row, not on `#floor` under the operator's name.
      onStuck: (message) => {
        void (async () => {
          const seat = await DaemonClient.open(repo, participant.id);
          await seat.post('/presence', { verb: 'starting', working: false, blocked: message });
        })().catch(() => {});
      },
      ...(options.spawnProcess === undefined ? {} : { spawn: options.spawnProcess }),
      ...(options.spawnPty === undefined ? {} : { spawnPty: options.spawnPty }),
      // Only when somebody is there to look. Capture is a parse per chunk, and
      // a seat nobody is watching should not pay for a screen nobody reads.
      ...(options.sessions === undefined ? {} : { capture: {} }),
    });
    options.sessions?.register(participant.id, session);
    spawned.push(participant.id);
    supervised.push(participant.id);

    loops.push(async () => {
      const seat = await DaemonClient.open(repo, participant.id);
      await driveSupervised({
        // Long-poll. The seat is not asked to check anything: the wake arrives
        // because something was said, which is the whole point of the change.
        wait: () => seat.get<Inbox>('/inbox?timeout_s=50'),
        write: (turn) => session.send(turn),
        exited: session.exited,
        formatTurn: boardTurn,
        // A seat that dies silently is how beacon-1 lost twenty minutes to a
        // teammate inferring, wrongly, that it was still working. So an exit
        // still reaches the board — once, from the seat itself. Everything
        // *reversible* about a seat's health goes to presence instead; those
        // were 622 of the vault-team run's 1187 events, all posted here under
        // `@human`, and a fact that flips back and forth is state, not history.
        notify: async (body) => {
          await seat.post('/presence', { verb: 'exited', working: false, blocked: body });
          await seat.post('/events', { kind: 'message', room: FLOOR, body });
        },
        onHealth: async (health) => {
          await seat.post('/presence', {
            verb: health.stuck ? 'waiting for the operator' : 'working',
            working: !health.stuck,
            blocked: health.why ?? '',
          });
        },
      });
    });
  }

  return {
    spawned,
    attached: attach.map((participant) => participant.id),
    posted: true,
    harnesses,
    supervised,
    supervise: async () => {
      await Promise.all(loops.map((run) => run()));
    },
  };
}

/**
 * A roster needs somebody who writes code — not specifically a leader.
 *
 * `compose` used to demand a `leader`, which predates flat peer shapes. The
 * trio the bench runs has no leader by design: three peers, a frozen contract,
 * and whoever picks up the integration. Requiring one rejected the shape that
 * beat the control, so the check now asks the question it actually meant.
 */
function requireSomeoneToWork(roles: readonly (string | undefined)[]): void {
  if (roles.some((role) => role === 'leader' || role === 'worker' || role === 'peer')) return;
  throw new CliError(
    'compose needs someone to do the work',
    EXIT.usage,
    'Add a leader, a worker, or a peer to the roster.',
  );
}

/**
 * Names the Remote Control session after the seat.
 *
 * `--remote-control` takes an optional name, and without one the session is
 * named after the host — so three seats on one machine are three sessions with
 * the same name, which is useless on a phone. The seat id is the name the
 * operator already knows it by from the board.
 */
export function nameRemoteControl(argv: readonly string[], seat: string): string[] {
  const at = argv.indexOf('--remote-control');
  if (at === -1) return [...argv];
  const next = argv[at + 1];
  // Already named (a flag follows, or nothing does, means it is unnamed).
  if (next !== undefined && !next.startsWith('-')) return [...argv];
  return [...argv.slice(0, at + 1), seat, ...argv.slice(at + 1)];
}

/** Per-seat model and effort, which the roster carries and the spawn never did. */
export function withSeatModel(
  argv: readonly string[],
  participant: { model?: string; effort?: string },
): string[] {
  const out = [...argv];
  if (participant.model !== undefined && !out.includes('--model')) out.push('--model', participant.model);
  if (participant.effort !== undefined && !out.includes('--effort')) out.push('--effort', participant.effort);
  return out;
}

/**
 * A fresh conversation for every launch.
 *
 * A seat is a new agent each run, not a continuation of the last one, and its
 * workspace is the same directory every time — so anything a harness carries
 * forward per directory is carried into a run that never asked for it. The
 * operator watched exactly that: launching again and landing back in the
 * wreckage of the previous, broken run, with its composer still full.
 *
 * Naming the conversation explicitly settles it rather than depending on what
 * any harness does by default. `--session-id` takes a UUID and pins the
 * conversation to it; a UUID nobody has used is a conversation nobody has had.
 * Only for `claude`, which is the flag's owner — another harness gets its argv
 * untouched.
 */
export function withFreshSession(argv: readonly string[], id: string = randomUUID()): string[] {
  if (argv[0] !== 'claude' || argv.includes('--session-id')) return [...argv];
  return [...argv, '--session-id', id];
}

async function markSupervised(repo: string): Promise<void> {
  const yamlPath = join(resolve(repo), 'crosstalk.yaml');
  let raw: string;
  try {
    raw = await readFile(yamlPath, 'utf8');
  } catch {
    throw new CliError(
      'compose needs a roster',
      EXIT.usage,
      'Pass --participant id:role:harness, or run `crosstalk init` first.',
    );
  }
  const config = parse(raw) as { participants?: Participant[] };
  const participants = config.participants;
  if (!Array.isArray(participants)) {
    throw new CliError('compose needs a roster', EXIT.usage, 'crosstalk.yaml has no participants.');
  }
  const registry = await loadRegistry();
  let changed = false;
  for (const participant of participants) {
    const descriptor = registry.get(participant.harness);
    if (descriptor?.supervisable === true && participant.lifecycle !== 'supervised') {
      participant.lifecycle = 'supervised';
      changed = true;
    }
  }
  if (changed) await writeFile(yamlPath, stringify(config), 'utf8');
}
