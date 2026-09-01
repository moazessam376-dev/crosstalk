import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { PhaseStatus } from '../../src/core/phase.js';

/**
 * The contract gate has to be meetable.
 *
 * `contract-exists` read `config.contractPath`, and nothing has ever written
 * that field — not `init`, not `POST /launch`, and there was no flag. Since
 * `phaseStatus` returns the first phase holding an unmet gate, every seat in
 * the fourteen-hour vault-team run was told, on every single turn, `plan:
 * contract-exists — no contract path is configured for this shape`, with
 * `writes: no-source`. All four built a game anyway. That is the correct call
 * and it is also the moment the phase field stopped meaning anything to them.
 *
 * A shape now names its own contract, so the gate asks a question the team can
 * answer.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
shape: trio-contract
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: peer-1
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-contract-gate-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function phaseOf(daemon: DaemonHandle): Promise<PhaseStatus> {
  const response = await fetch(`${daemon.url}/phase`, {
    headers: { authorization: `Bearer ${daemon.tokens.get('peer-1')!}` },
  });
  return (await response.json()) as PhaseStatus;
}

describe('the contract gate, with no contractPath in the config', () => {
  it('asks for the shape’s own contract file, by name', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const phase = await phaseOf(daemon);
    const contract = phase.gates.find((gate) => gate.id === 'contract-exists')!;

    expect(contract.met).toBe(false);
    // The old message. It names no file, so there is nothing a seat could do.
    expect(contract.missing).not.toContain('no contract path is configured');
    expect(contract.missing).toContain('src/contract.ts');
  });

  it('is met once that file has content, so plan can be left', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    expect((await phaseOf(daemon)).blocking.join(' ')).toContain('contract-exists');

    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'contract.ts'), 'export type Decision = { id: string };\n', 'utf8');

    const after = await phaseOf(daemon);
    expect(after.gates.find((gate) => gate.id === 'contract-exists')!.met).toBe(true);
    expect(after.blocking.join(' ')).not.toContain('contract-exists');
  });

  it('lets the config override the shape default', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'crosstalk.yaml'), `${CONFIG}contractPath: api/shared.ts\n`, 'utf8');
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const contract = (await phaseOf(daemon)).gates.find((gate) => gate.id === 'contract-exists')!;
    expect(contract.missing).toContain('api/shared.ts');
  });
});
