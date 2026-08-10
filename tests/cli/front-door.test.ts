import { describe, it, expect } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { realpath as realpathCallback } from 'node:fs';
import { access, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { resolveAsset } from '../../src/daemon/hub.js';
import { browserCommand } from '../../src/cli/open.js';
import { exitCodeFor, CliError, EXIT } from '../../src/cli/client.js';
import { parse, stringify } from 'yaml';

import type { CrosstalkConfig } from '../../src/contracts/config.js';
import { runInit, purgeWorkspaces, preflight, samePath, type PathResolver } from '../../src/cli/init.js';
import { doctor } from '../../src/harness/doctor.js';
import { listWorktrees } from '../../src/workspace/git.js';

const execFile = promisify(execFileCallback);

/**
 * These tests drive real git — `AGENTS.md` forbids mocking it — and creating a
 * repository, adding a worktree, purging it and re-initialising is a dozen
 * subprocess spawns. On Windows under a loaded runner that overruns vitest's
 * 5s default, which showed up as one failure in five consecutive runs of an
 * otherwise green suite. The work is legitimate; the default is not.
 */
const GIT_TEST_TIMEOUT = 30_000;

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ct-cli-'));
}

/**
 * A real throwaway repository, never a mock — `AGENTS.md`. `init` creates git
 * worktrees, and a worktree cannot be added to a directory git does not own.
 */
async function gitRepo(): Promise<string> {
  const repo = await tempRepo();
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'export {};\n', 'utf8');
  // A worktree needs a commit to branch from.
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const realpathNative = promisify(realpathCallback.native);

/**
 * The canonical on-disk spelling, lowercased.
 *
 * Deliberately not `samePath` — using the function under test to write the
 * assertion would make these pass for the wrong reason. `realpath.native`
 * directly is the independent check.
 */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  return (await realpathNative(absolute).catch(() => absolute)).toLowerCase();
}

async function registeredWorktrees(repo: string): Promise<string[]> {
  return Promise.all((await listWorktrees(repo)).map((entry) => canonicalPath(entry.path)));
}

/** `git check-ignore` exits 0 when a rule matches and 1 when none does. */
async function isIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await execFile('git', ['check-ignore', '-q', '--', path], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function initialised(): Promise<string> {
  const repo = await tempRepo();
  await runInit({ repo, participants: [], force: false });
  return repo;
}

async function withDaemon<T>(
  repo: string,
  fn: (d: DaemonHandle) => Promise<T>,
  hubDist?: string,
): Promise<T> {
  const daemon = await startDaemon({ repo, ...(hubDist === undefined ? {} : { hubDist }) });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

describe('crosstalk init', () => {
  it('writes a config, one token per participant, and @human among them', async () => {
    const repo = await tempRepo();
    const result = await runInit({ repo, participants: [], force: false });

    expect(result.config.participants.map((p) => p.id)).toContain('@human');
    // @human is a participant in every room and the browser bootstrap presents
    // its token, so it needs one of its own.
    expect(result.tokens.get('@human')).toMatch(/^[0-9a-f]{64}$/);
    // '@' is stripped for the filename; PARTICIPANT_ID_PATTERN rejects '@human'.
    expect((await readFile(join(repo, '.crosstalk', 'tokens', 'human'), 'utf8')).trim()).toBe(
      result.tokens.get('@human'),
    );
  });

  it('points .mcp.json at the package, not at the target repository', async () => {
    const repo = await initialised();
    const mcp = JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')) as {
      mcpServers: { crosstalk: { args: string[]; env: Record<string, string> } };
    };

    // The MCP server ships with the package. A path under the target repo would
    // name a file that never exists there, and a server that fails to spawn
    // tells the agent nothing it can act on.
    expect(mcp.mcpServers.crosstalk.args[0]).not.toContain(resolve(repo));
    expect(mcp.mcpServers.crosstalk.args[0]).toMatch(/dist[\\/]mcp[\\/]index\.js$/);
    expect(mcp.mcpServers.crosstalk.env['CROSSTALK_REPO']).toBe(resolve(repo));
    // The url is discovered from daemon.json, never configured: the port is ephemeral.
    expect(mcp.mcpServers.crosstalk.env).not.toHaveProperty('CROSSTALK_URL');
  });

  it('gitignores .crosstalk so tokens cannot be committed', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
    await runInit({ repo, participants: [], force: false });

    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toMatch(/^\.crosstalk\/$/m);
  });

  it('refuses to clobber an existing config without --force', async () => {
    const repo = await initialised();
    await expect(runInit({ repo, participants: [], force: false })).rejects.toMatchObject({
      exitCode: EXIT.usage,
    });
    await expect(runInit({ repo, participants: [], force: true })).resolves.toBeTruthy();
  });

  it('keeps tokens stable across a daemon restart, so .mcp.json stays valid', async () => {
    const repo = await initialised();
    const minted = JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')) as {
      mcpServers: { crosstalk: { env: Record<string, string> } };
    };
    // The registration references the token file rather than embedding the
    // token, so what has to stay stable is what that file holds.
    const tokenFile = minted.mcpServers.crosstalk.env['CROSSTALK_TOKEN_FILE']!;
    expect(tokenFile).toBeTruthy();

    for (let run = 0; run < 2; run += 1) {
      await withDaemon(repo, async (daemon) => {
        // Re-minting on every start would invalidate the token the registration
        // points at, and the agent holding it would see a 401 it could not explain.
        const referenced = (await readFile(tokenFile, 'utf8')).trim();
        expect([...daemon.tokens.values()]).toContain(referenced);
      });
    }
  });
});

describe('two spellings of one path', () => {
  // Hard-coded rather than manufactured: generating a real 8.3 alias needs a
  // volume with short-name creation enabled, which is not something a test can
  // assume. These are the exact spellings the GitHub Windows runner produces —
  // os.tmpdir() hands out C:\Users\RUNNER~1\..., `git worktree list` reports
  // C:\Users\runneradmin\..., and lowercasing does not bridge them.
  const LONG = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ct-cli-a1\\.crosstalk\\worktrees\\codex';
  const SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ct-cli-a1\\.crosstalk\\worktrees\\codex';
  const OTHER = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ct-cli-a1\\.crosstalk\\worktrees\\cursor';

  /** Stands in for `realpath.native`, the only thing that expands 8.3. */
  const expand: PathResolver = async (path) => path.replace('RUNNER~1', 'runneradmin');

  it('treats an 8.3 short path and its long form as one worktree', async () => {
    expect(await samePath(SHORT, LONG, expand)).toBe(true);
  });

  it('still says no to a genuinely different worktree', async () => {
    // The discrimination that matters: a comparator returning true whenever it
    // is asked would satisfy the test above and be completely wrong. Both
    // spellings resolve here, so this cannot pass by the resolver failing.
    expect(await samePath(SHORT, OTHER, expand)).toBe(false);
    expect(await samePath(LONG, OTHER, expand)).toBe(false);
  });

  it('falls back to the lexical comparison for a path that does not exist yet', async () => {
    // The ordinary case the first time a worktree is created: realpath throws,
    // and a worktree that is genuinely absent must still compare unequal.
    const absent: PathResolver = async () => { throw new Error('ENOENT'); };
    expect(await samePath(LONG, LONG, absent)).toBe(true);
    expect(await samePath(LONG, OTHER, absent)).toBe(false);
  });
});

describe('init builds the workspace it promises', () => {
  it('leaves doctor with zero BRIEF_STALE findings on a repo it just created', async () => {
    const repo = await gitRepo();
    const { config } = await runInit({ repo, participants: [], force: false });

    const stale = (await doctor(config, repo)).filter((f) => f.code === 'BRIEF_STALE');
    // The product's first two commands must not disagree about a file one of
    // them just wrote. Baseline before B1 is two on the default roster.
    expect(stale.map((f) => f.message)).toEqual([]);
  }, GIT_TEST_TIMEOUT);

  it('creates one registered worktree per worker, and none for the leader or @human', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });

    // Canonicalised on both sides: `os.tmpdir()` is an 8.3 short path on the
    // Windows runners and `git worktree list` reports the long form, so a
    // literal string comparison fails there for a worktree that exists.
    const registered = await registeredWorktrees(repo);
    expect(registered).toContain(await canonicalPath(join(repo, '.crosstalk', 'worktrees', 'codex')));
    // The leader owns the primary checkout and @human never gets one, so a
    // worktree for either would be the §7 two-agents-one-checkout failure.
    expect(registered).not.toContain(await canonicalPath(join(repo, '.crosstalk', 'worktrees', 'leader')));
    expect(registered).not.toContain(await canonicalPath(join(repo, '.crosstalk', 'worktrees', 'human')));
  }, GIT_TEST_TIMEOUT);

  it('leaves no .mcp.json committable, at the root or inside a worker worktree', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });
    const worktree = join(repo, '.crosstalk', 'worktrees', 'codex');
    await writeFile(join(worktree, '.mcp.json'), '{}\n', 'utf8');

    // A linked worktree resolves .mcp.json against its own root, which the
    // top-level .gitignore's `.crosstalk/` rule cannot match. The token in
    // that file would ride out on the worker's next `git add -A`.
    expect(await isIgnored(repo, '.mcp.json')).toBe(true);
    expect(await isIgnored(worktree, '.mcp.json')).toBe(true);
    // The neighbouring case that must NOT be ignored, or the rule is too broad.
    expect(await isIgnored(worktree, 'src/index.ts')).toBe(false);
  }, GIT_TEST_TIMEOUT);

  it('purges every worktree it created, and re-initialises cleanly afterwards', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });
    const worktree = join(repo, '.crosstalk', 'worktrees', 'codex');
    const canonical = await canonicalPath(worktree);
    expect(await registeredWorktrees(repo)).toContain(canonical);

    await purgeWorkspaces(repo);

    expect(await registeredWorktrees(repo)).not.toContain(canonical);
    expect(await pathExists(worktree)).toBe(false);

    // `down --purge` leaves the branch behind, so a second `init` has to adopt
    // it rather than fail on `worktree add -b`.
    await runInit({ repo, participants: [], force: true });
    expect(await registeredWorktrees(repo)).toContain(await canonicalPath(worktree));
  }, GIT_TEST_TIMEOUT);

  it('preserves a worker\'s uncommitted file when init --force re-runs', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });
    const scratch = join(repo, '.crosstalk', 'worktrees', 'codex', 'WORK-IN-PROGRESS.txt');
    await writeFile(scratch, 'half-finished\n', 'utf8');

    await runInit({ repo, participants: [], force: true });

    expect(await readFile(scratch, 'utf8')).toBe('half-finished\n');
  }, GIT_TEST_TIMEOUT);
});

describe('up refuses a configuration doctor rejects', () => {
  /** A hand-edited config is the only way to get one: `init` now refuses to write it. */
  async function withTwoLeaders(repo: string): Promise<void> {
    const config = parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as CrosstalkConfig;
    const leader = config.participants.find((p) => p.role === 'leader')!;
    config.participants.push({ ...leader, id: 'leader2' });
    await writeFile(join(repo, 'crosstalk.yaml'), stringify(config), 'utf8');
  }

  it('refuses to start, and binds nothing, when doctor rejects', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });
    await withTwoLeaders(repo);

    const error = await preflight(repo, false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.protocol);
    expect((error as CliError).message).toContain('LEADER_COUNT');

    // `startDaemon` writes daemon.json as it binds. Its absence is the
    // observable form of "no port was bound" — asserting on the thrown error
    // alone would pass even if the daemon had started first.
    expect(await pathExists(join(repo, '.crosstalk', 'daemon.json'))).toBe(false);
  }, GIT_TEST_TIMEOUT);

  it('starts when the only findings are warnings', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });

    // The default roster warns (one worker, MCP probe falls back) and must
    // still start, or `up` is unusable on the config `init` itself writes.
    const findings = await preflight(repo, false);
    expect(findings.every((f) => f.level === 'warn')).toBe(true);
    expect(findings.some((f) => f.code === 'THIRD_AGENT_UNAVAILABLE')).toBe(true);
  }, GIT_TEST_TIMEOUT);

  it('starts a rejected config anyway under --force', async () => {
    const repo = await gitRepo();
    await runInit({ repo, participants: [], force: false });
    await withTwoLeaders(repo);

    const findings = await preflight(repo, true);
    expect(findings.some((f) => f.code === 'LEADER_COUNT' && f.level === 'reject')).toBe(true);
  }, GIT_TEST_TIMEOUT);

  it('refuses to write a config with zero or several leaders', async () => {
    const repo = await gitRepo();
    const two = ['a:leader:claude-code-app', 'b:leader:claude-code-app'];
    await expect(runInit({ repo, participants: two, force: false })).rejects.toMatchObject({
      exitCode: EXIT.protocol,
    });
    // A generator that emits what the validator rejects is the bug, so nothing
    // should have been written for `doctor` to complain about later.
    expect(await pathExists(join(repo, 'crosstalk.yaml'))).toBe(false);

    const none = ['a:worker:claude-code-app'];
    await expect(runInit({ repo, participants: none, force: false })).rejects.toMatchObject({
      exitCode: EXIT.protocol,
    });

    // The neighbouring case that must still be accepted.
    await expect(
      runInit({ repo, participants: ['a:leader:claude-code-app'], force: false }),
    ).resolves.toBeTruthy();
  }, GIT_TEST_TIMEOUT);
});

describe('the hub front door', () => {
  it('serves the built shell at / without a credential', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  it('exchanges a bootstrap token for a cookie and redirects it out of the address bar', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const token = daemon.tokens.get('@human')!;
      const response = await fetch(`${daemon.url}/?t=${token}`, { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`ct_token=${token}`);
      // Not readable from script, and not sent cross-site.
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    });
  });

  it('refuses a bootstrap token that is not a participant token', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/?t=not-a-token`, { redirect: 'manual' });
      expect(response.status).toBe(401);
    });
  });

  it('serves /config.json to the cookie the bootstrap set, and 401s without it', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const token = daemon.tokens.get('@human')!;
      const authed = await fetch(`${daemon.url}/config.json`, {
        headers: { cookie: `ct_token=${token}` },
      });
      expect(await authed.json()).toEqual({
        version: 1,
        self: '@human',
        streamUrl: '/stream',
        room: '#floor',
      });

      expect((await fetch(`${daemon.url}/config.json`)).status).toBe(401);
    });
  });

  it('names the command that builds the hub instead of 404ing', async () => {
    const repo = await initialised();
    const absent = join(repo, 'nowhere', 'ui');
    await withDaemon(
      repo,
      async (daemon) => {
        const response = await fetch(`${daemon.url}/`);
        // "Crosstalk is broken" and "one command has not been run" look identical
        // as a bare 404. Every failure message names the remedy.
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(body).toContain('npm run build:ui');
      },
      absent,
    );
  });
});

describe('static serving refuses to escape the bundle', () => {
  it.each([
    ['/../package.json'],
    ['/assets/../../package.json'],
    ['/..%2fpackage.json'],
  ])('refuses %s', (pathname) => {
    const root = resolve('/srv/dist/ui');
    const resolved = resolveAsset(root, decodeURIComponent(pathname));
    expect(resolved === undefined || resolved.startsWith(root)).toBe(true);
  });

  it('resolves an ordinary asset inside the bundle', () => {
    const root = resolve('/srv/dist/ui');
    expect(resolveAsset(root, '/assets/index.js')).toBe(join(root, 'assets', 'index.js'));
    expect(resolveAsset(root, '/')).toBe(join(root, 'index.html'));
  });
});

describe('cli plumbing', () => {
  it('opens a browser without a shell', () => {
    const { file, args } = browserCommand('http://127.0.0.1:1/?t=a&b=c');
    // execFile takes argv, so an ampersand in the url cannot become a second
    // command. On Windows `cmd /c start` would need a shell; rundll32 does not.
    expect(file).not.toMatch(/cmd(\.exe)?$/i);
    expect(args.some((arg) => arg.includes('&b=c'))).toBe(true);
  });

  it('maps daemon status onto the published exit codes', () => {
    expect(exitCodeFor(401)).toBe(EXIT.auth);
    expect(exitCodeFor(403)).toBe(EXIT.auth);
    expect(exitCodeFor(422)).toBe(EXIT.protocol);
    expect(exitCodeFor(409)).toBe(EXIT.protocol);
    expect(exitCodeFor(404)).toBe(EXIT.usage);
    expect(exitCodeFor(500)).toBe(EXIT.daemon);
  });
});

describe('the SSE stream the hub subscribes to', () => {
  it('sends default-typed frames with id set to seq, and resumes exclusively', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const token = daemon.tokens.get('leader')!;
      const say = (body: string): Promise<Response> =>
        fetch(`${daemon.url}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind: 'message', room: '#floor', body }),
        });

      await say('one');
      await say('two');

      const response = await fetch(`${daemon.url}/stream`, {
        headers: { authorization: `Bearer ${token}`, 'last-event-id': '2' },
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      // Read until the backlog after seq 2 has arrived.
      while (!buffered.includes('"body":"two"')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      // Exclusive resume: seq 2 must not be redelivered.
      expect(buffered).toContain('id: 3');
      expect(buffered).not.toMatch(/^id: 2$/m);
      // No `event:` name — the hub's stream.onmessage only fires for the
      // default type, and a named frame is a silent blank screen.
      expect(buffered).not.toMatch(/^event:/m);
    });
  });
});
