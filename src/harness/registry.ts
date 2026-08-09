import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
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

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath === '~') return homedir();
  if (configPath.startsWith('~/') || configPath.startsWith(`~${sep}`) || configPath.startsWith('~\\')) {
    return join(homedir(), configPath.slice(2));
  }
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}

export async function probeTier(descriptor: HarnessDescriptor, cwd: string): Promise<Tier> {
  if (descriptor.mcp !== 'none' && descriptor.mcpConfigPath !== undefined) {
    try {
      await access(resolveConfigPath(descriptor.mcpConfigPath, cwd), constants.F_OK | constants.W_OK);
      return 'mcp';
    } catch {
      // A missing or unwritable registration file loses MCP capability only.
    }
  }
  return 'shell';
}
