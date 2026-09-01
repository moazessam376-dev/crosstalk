import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GateId } from '../core/shape.js';
import { changedFiles } from './git.js';

/**
 * The gates Crosstalk can settle by looking, rather than by being told.
 *
 * Both of these are the beacon-1 post-mortem written as checks. The contract
 * kept moving under three seats, so `Ship.lane` arrived mid-flight and
 * `laneBearing` ended up defined twice; and the split was equal by effort
 * rather than disjoint by file, so a defect fell between two files with no
 * owner. Neither would have survived a gate that ran.
 */

export interface WorkspaceGate {
  met: boolean;
  missing?: string;
}

export async function contractExists(repo: string, contractPath: string): Promise<WorkspaceGate> {
  const full = join(resolve(repo), contractPath);
  try {
    const found = await stat(full);
    if (!found.isFile() || found.size === 0) {
      return { met: false, missing: `${contractPath} is empty` };
    }
    return { met: true };
  } catch {
    return { met: false, missing: `${contractPath} does not exist yet` };
  }
}

/**
 * Whether any two seat branches have written the same file.
 *
 * This is the Build gate, and it is the whole reason three writers is
 * defensible. `git diff --name-only base...branch` per seat, intersected
 * pairwise: an empty intersection means the split held.
 */
export async function noSharedFiles(
  repo: string,
  base: string,
  branches: readonly { seat: string; branch: string }[],
): Promise<WorkspaceGate> {
  const owned = new Map<string, string[]>();
  const unchecked: string[] = [];
  for (const { seat, branch } of branches) {
    const changed = await changedFiles(repo, base, branch);
    if (changed === undefined) {
      unchecked.push(`${seat} (${branch} is unknown)`);
      continue;
    }
    owned.set(seat, changed);
  }

  // Said before the intersection, because a seat whose branch could not be read
  // contributes an empty set to it, and an empty set collides with nothing. An
  // unreadable branch reported as "no overlap" is how this gate stayed green
  // through every run it has ever been part of.
  if (unchecked.length > 0) {
    return { met: false, missing: `no branch to check for ${unchecked.join('; ')}` };
  }

  const collisions: string[] = [];
  const seats = [...owned.keys()];
  for (let i = 0; i < seats.length; i += 1) {
    for (let j = i + 1; j < seats.length; j += 1) {
      const left = seats[i]!;
      const right = seats[j]!;
      const shared = owned.get(left)!.filter((path) => owned.get(right)!.includes(path));
      for (const path of shared) collisions.push(`${path} (${left} and ${right})`);
    }
  }

  if (collisions.length === 0) return { met: true };
  return {
    met: false,
    // Named, because the seats have to decide who keeps it — and a count alone
    // would send all three re-reading every diff to find out.
    missing: `two seats wrote the same file: ${collisions.join('; ')}`,
  };
}

/**
 * The gate ids `workspaceGates` knows how to answer.
 *
 * Exported so a shape can be checked against it. A shape naming a gate nothing
 * implements does not fail loudly — `workspaceGates` simply never sets it,
 * `statusOf` reads it as unmet, and the phase stalls forever.
 */
export const WORKSPACE_GATES: readonly GateId[] = ['contract-exists', 'no-shared-files'];

export async function workspaceGates(args: {
  repo: string;
  base: string;
  contractPath?: string;
  branches: readonly { seat: string; branch: string }[];
  needed: readonly GateId[];
}): Promise<Map<GateId, WorkspaceGate>> {
  const results = new Map<GateId, WorkspaceGate>();

  if (args.needed.includes('contract-exists')) {
    results.set(
      'contract-exists',
      args.contractPath === undefined
        ? { met: false, missing: 'no contract path is configured for this shape' }
        : await contractExists(args.repo, args.contractPath),
    );
  }

  if (args.needed.includes('no-shared-files')) {
    results.set('no-shared-files', await noSharedFiles(args.repo, args.base, args.branches));
  }

  return results;
}
