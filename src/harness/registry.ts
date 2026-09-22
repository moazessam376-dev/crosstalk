import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { Tier } from '../contracts/index.js';

export interface HarnessDescriptor {
  key: string;
  briefFile: string;
  mcp: 'stdio' | 'http' | 'unverified' | 'none';
  mcpConfigPath?: string;
  supervisable: boolean;
  spawn?: string[];
}

const MCP_KINDS = new Set<HarnessDescriptor['mcp']>(['stdio', 'http', 'unverified', 'none']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, key: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Harness ${key} has an invalid ${field}`);
  }
  return value;
}

function descriptorFrom(key: string, raw: unknown): HarnessDescriptor {
  if (!isRecord(raw)) throw new Error(`Harness ${key} must be a mapping`);

  const mcp = raw.mcp;
  if (typeof mcp !== 'string' || !MCP_KINDS.has(mcp as HarnessDescriptor['mcp'])) {
    throw new Error(`Harness ${key} has an invalid mcp kind`);
  }

  const mcpConfigPath = raw.mcpConfigPath;
  if (mcpConfigPath !== undefined && typeof mcpConfigPath !== 'string') {
    throw new Error(`Harness ${key} has an invalid mcpConfigPath`);
  }

  const spawn = raw.spawn;
  if (spawn !== undefined && (!Array.isArray(spawn) || !spawn.every((part) => typeof part === 'string'))) {
    throw new Error(`Harness ${key} has an invalid spawn command`);
  }

  return {
    key,
    briefFile: requiredString(raw.briefFile, 'briefFile', key),
    mcp: mcp as HarnessDescriptor['mcp'],
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    supervisable: raw.supervisable === true,
    ...(spawn === undefined ? {} : { spawn: [...spawn] as string[] }),
  };
}

async function registryText(): Promise<string> {
  const candidates = [
    new URL('./harnesses.yaml', import.meta.url),
    new URL('../../src/harness/harnesses.yaml', import.meta.url),
  ];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to load harness registry');
}

export async function loadRegistry(): Promise<Map<string, HarnessDescriptor>> {
  const document = parse(await registryText()) as unknown;
  if (!isRecord(document) || !isRecord(document.harnesses)) {
    throw new Error('Harness registry must contain a harnesses mapping');
  }

  const registry = new Map<string, HarnessDescriptor>();
  for (const [key, raw] of Object.entries(document.harnesses)) {
    registry.set(key, descriptorFrom(key, raw));
  }
  return registry;
}

export function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath === '~') return homedir();
  if (configPath.startsWith('~/') || configPath.startsWith(`~${sep}`) || configPath.startsWith('~\\')) {
    return join(homedir(), configPath.slice(2));
  }
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}

/**
 * Which transport this harness can actually be driven over.
 *
 * CT-2. The previous probe asked whether the file at `mcpConfigPath` existed
 * and was writable — but `init` is what creates that file. So it measured
 * whether Crosstalk had written a config, not whether the harness reads one,
 * and the answer flipped depending on when you asked: `shell` before `init`,
 * `mcp` after, for a harness whose capabilities had not changed. `doctor` then
 * reported no `MCP_PROBE_FALLBACK`, asserting the mcp tier was healthy, on the
 * strength of a file Crosstalk had just written to itself.
 *
 * Capability is a property of the harness. Three conditions, all about the
 * harness rather than about our own output:
 *
 * - `mcp: 'stdio'` — a transport we have actually verified. `'unverified'` is
 *   a claim nobody has checked and `'http'` is not wired, so neither earns the
 *   mcp tier; `'none'` never did.
 * - it names an `mcpConfigPath` at all, or there is nowhere to register.
 * - that path is inside the workspace. B3 refuses to write outside the
 *   repository it was pointed at and prints instructions instead, so a harness
 *   configured at `~/.codex/config.toml` has no registration it can read.
 *
 * Deliberately not a filesystem existence check: the tier must be the same
 * before and after `init` runs, or it is describing us and not the harness.
 */
export async function probeTier(descriptor: HarnessDescriptor, cwd: string): Promise<Tier> {
  if (descriptor.mcp !== 'stdio' || descriptor.mcpConfigPath === undefined) return 'shell';

  const configPath = resolveConfigPath(descriptor.mcpConfigPath, cwd);
  if (!isWithin(cwd, configPath)) return 'shell';

  // The containing directory has to be creatable for a registration to exist.
  // The *file* need not: `init` has not necessarily run yet, and requiring it
  // is exactly the circularity above.
  return (await writableAncestor(configPath)) ? 'mcp' : 'shell';
}

function isWithin(parent: string, target: string): boolean {
  const child = relative(resolve(parent), resolve(target));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

async function writableAncestor(path: string): Promise<boolean> {
  let current = dirname(resolve(path));
  for (;;) {
    try {
      await access(current, constants.W_OK);
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}
