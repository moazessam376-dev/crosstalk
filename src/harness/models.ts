import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { HarnessDescriptor } from './registry.js';

const execFile = promisify(execFileCb);

/**
 * What models a harness can actually be put on, asked rather than assumed.
 *
 * The registry shipped a hand-written list per harness. Hand-written lists go
 * stale in the one direction that matters — the operator's Codex offered luna,
 * terra and sol at 5.6, and the launcher offered `gpt-5.3-codex`, which does not
 * exist for them. A list that cannot be chosen from is worse than no list: it
 * looks authoritative and it is wrong.
 *
 * So three sources, in order of how much they know:
 *
 *  1. **The binary.** Codex's app server answers `model/list` with ids, display
 *     names and the reasoning efforts each model supports. That is the truth,
 *     from the thing that will run the seat.
 *  2. **The binary's own help.** Claude Code has no listing command, but names
 *     its aliases in `--help`, which is still the CLI's own word rather than
 *     ours.
 *  3. **The registry.** Whatever was written down, marked as such.
 *
 * And under all three: **free text always wins.** `Participant.model` is a
 * string by contract, the launcher lets one be typed, and nothing here refuses
 * a model it has not heard of. Discovery makes the common case one click; it
 * never becomes a gate.
 */

export interface DiscoveredModel {
  id: string;
  label: string;
  /** Effort levels this model accepts, when the harness says. Ordered as given. */
  efforts?: string[];
  /** What the harness would use if nothing were chosen. */
  isDefault?: boolean;
}

export interface ModelCatalogue {
  models: DiscoveredModel[];
  /**
   * Where the list came from, so the hub can say. An operator who knows the
   * list was read off their own binary trusts it; one who is shown a stale
   * hard-coded list and not told stops trusting the whole panel.
   */
  source: 'binary' | 'help' | 'registry' | 'none';
}

/** Long enough that a launcher click is instant; short enough to notice an upgrade. */
const CACHE_MS = 5 * 60 * 1000;
/** A discovery that has not answered by now is one the operator is waiting on. */
const PROBE_MS = 6000;

const cache = new Map<string, { at: number; value: ModelCatalogue }>();

/** For tests, and for a `doctor` run that must not read a stale answer. */
export function forgetModels(): void {
  cache.clear();
}

/**
 * Codex, asked directly.
 *
 * `codex app-server` speaks JSON-RPC over stdio and answers `model/list` with
 * the same catalogue its own picker shows — including which efforts each model
 * takes, which is the part no hand-written list has ever carried.
 */
async function fromCodex(binary: string): Promise<DiscoveredModel[] | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value: DiscoveredModel[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), PROBE_MS);
    child.on('error', () => finish(undefined));
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue;
        let message: { id?: unknown; result?: { data?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id !== 1 || !Array.isArray(message.result?.data)) continue;
        finish(
          (message.result.data as Record<string, unknown>[])
            // Hidden models are hidden from Codex's own picker; showing them
            // here would make the hub's list differ from the CLI's.
            .filter((model) => model.hidden !== true && typeof model.id === 'string')
            .map((model) => {
              const efforts = Array.isArray(model.supportedReasoningEfforts)
                ? (model.supportedReasoningEfforts as Record<string, unknown>[])
                    .map((entry) => entry.reasoningEffort)
                    .filter((effort): effort is string => typeof effort === 'string')
                : undefined;
              return {
                id: model.id as string,
                label: typeof model.displayName === 'string' ? model.displayName : (model.id as string),
                ...(efforts !== undefined && efforts.length > 0 ? { efforts } : {}),
              };
            }),
        );
        return;
      }
    });

    try {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { clientInfo: { name: 'crosstalk', title: 'crosstalk', version: '0' } },
        })}\n`,
      );
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'model/list', params: {} })}\n`);
    } catch {
      finish(undefined);
    }
  });
}

/**
 * Claude Code, read off its own help.
 *
 * There is no listing command, and its `--model` help names the aliases it
 * takes: "Provide an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet') or a model's full name (e.g. 'claude-fable-5')". Quoted words in
 * that sentence are the CLI's own vocabulary, which beats ours, and anything
 * missed is still typeable.
 */
export function claudeAliases(help: string): string[] {
  const at = help.indexOf('--model');
  if (at === -1) return [];
  // The paragraph for this one flag: help output indents continuation lines, so
  // the option ends where the next flag starts.
  const rest = help.slice(at);
  const end = rest.search(/\n\s{2}-{1,2}[a-zA-Z]/);
  const paragraph = end === -1 ? rest : rest.slice(0, end);
  const quoted = [...paragraph.matchAll(/'([a-zA-Z][a-zA-Z0-9.\-]{1,48})'/g)].map((match) => match[1]!);
  return [...new Set(quoted)];
}

async function fromHelp(binary: string): Promise<DiscoveredModel[] | undefined> {
  try {
    const { stdout } = await execFile(binary, ['--help'], { timeout: PROBE_MS });
    const aliases = claudeAliases(stdout);
    if (aliases.length === 0) return undefined;
    return aliases.map((id) => ({ id, label: id }));
  } catch {
    return undefined;
  }
}

/**
 * The models this harness offers on this machine.
 *
 * Never throws and never blocks a launch: every probe failure falls through to
 * the registry, and the registry being empty falls through to nothing at all,
 * which the launcher renders as a free-text field rather than as an error.
 */
export async function discoverModels(
  key: string,
  descriptor: Pick<HarnessDescriptor, 'models' | 'spawn'> | undefined,
  now: number = Date.now(),
): Promise<ModelCatalogue> {
  const cached = cache.get(key);
  if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;

  const binary = descriptor?.spawn?.[0];
  let value: ModelCatalogue | undefined;

  if (binary !== undefined) {
    const probed = binary === 'codex' ? await fromCodex(binary) : await fromHelp(binary);
    if (probed !== undefined && probed.length > 0) {
      value = { models: probed, source: binary === 'codex' ? 'binary' : 'help' };
    }
  }

  if (value === undefined) {
    const listed = descriptor?.models ?? [];
    value =
      listed.length > 0
        ? { models: listed.map((id) => ({ id, label: id })), source: 'registry' }
        : { models: [], source: 'none' };
  }

  cache.set(key, { at: now, value });
  return value;
}
