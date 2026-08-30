import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import { HUMAN_ID } from '../contracts/room.js';
import type { Participant } from '../contracts/participant.js';
import { loadConfig } from '../daemon/config.js';
import { loadRegistry, type HarnessDescriptor } from '../harness/registry.js';
import { probeCliHarnesses, type PathProbe } from '../harness/path.js';
import { spawnSupervised, type ExecFile } from '../harness/runner.js';
import { CliError, DaemonClient, EXIT, type WriteResult } from './client.js';
import { runInit } from './init.js';

export interface ComposeOptions {
  repo: string;
  job: string;
  participants: string[];
  force?: boolean;
  /** Injected in tests. */
  spawn?: (argv: string[], cwd: string) => void;
  execFile?: ExecFile;
  postJob?: (repo: string, job: string) => Promise<void>;
}

export interface ComposeResult {
  spawned: string[];
  attached: string[];
  posted: boolean;
  harnesses: PathProbe[];
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
    const parsed = options.participants.map((spec) => spec.split(':'));
    if (!parsed.some((parts) => parts[1] === 'leader')) {
      throw new CliError('compose needs a leader', EXIT.usage, 'Pass --participant id:leader:harness.');
    }
    await runInit({
      repo,
      participants: options.participants,
      force: options.force === true,
    });
  }

  await markSupervised(repo);
  const config = await loadConfig(repo);
  if (!config.participants.some((participant) => participant.role === 'leader')) {
    throw new CliError('compose needs a leader', EXIT.usage, 'Add a leader participant first.');
  }

  const registry = await loadRegistry();
  const { spawn, attach } = selectSpawnTargets(config.participants, registry);
  const harnesses = await probeCliHarnesses();

  if (options.postJob !== undefined) {
    await options.postJob(repo, job);
  } else {
    const client = await DaemonClient.open(repo, HUMAN_ID);
    await client.post<WriteResult>('/events', { kind: 'message', room: '#floor', body: job });
  }

  const spawned: string[] = [];
  for (const participant of spawn) {
    const argv = registry.get(participant.harness)?.spawn;
    if (argv === undefined) continue;
    const cwd = resolve(repo, participant.workspace);
    const full = [...argv, job];
    if (options.spawn !== undefined) {
      options.spawn(full, cwd);
    } else {
      spawnSupervised({ argv: full, cwd, execFile: options.execFile });
    }
    spawned.push(participant.id);
  }

  return { spawned, attached: attach.map((participant) => participant.id), posted: true, harnesses };
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
