import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon } from '../../src/daemon/server.js';
import { ConfigError, loadMcpConfig } from '../../src/mcp/config.js';

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
`;

async function tempRepo(daemonJson?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mcp-config-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  if (daemonJson !== undefined) {
    await writeFile(join(dir, '.crosstalk', 'daemon.json'), daemonJson, 'utf8');
  }
  return dir;
}

describe('the token is referenced, not embedded', () => {
  it('reads the token from CROSSTALK_TOKEN_FILE', async () => {
    const repo = await tempRepo('{"version":1,"url":"http://127.0.0.1:1","pid":1,"startedAt":"x"}');
    const path = join(repo, '.crosstalk', 'tokens', 'codex');
    await mkdir(join(repo, '.crosstalk', 'tokens'), { recursive: true });
    // Trailing newline is how `init` writes it and how a human would edit it.
    await writeFile(path, 'from-the-file\n', 'utf8');

    const config = await loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN_FILE: path });
    expect(config.token).toBe('from-the-file');
  });

  it('prefers CROSSTALK_TOKEN when both are set, so CLI use is unchanged', async () => {
    const repo = await tempRepo('{"version":1,"url":"http://127.0.0.1:1","pid":1,"startedAt":"x"}');
    const path = join(repo, '.crosstalk', 'tokens', 'codex');
    await mkdir(join(repo, '.crosstalk', 'tokens'), { recursive: true });
    await writeFile(path, 'from-the-file', 'utf8');

    const config = await loadMcpConfig({
      CROSSTALK_REPO: repo,
      CROSSTALK_TOKEN: 'from-the-env',
      CROSSTALK_TOKEN_FILE: path,
    });
    expect(config.token).toBe('from-the-env');
  });

  it('fails loudly when the token file is missing or empty', async () => {
    const repo = await tempRepo('{"version":1,"url":"http://127.0.0.1:1","pid":1,"startedAt":"x"}');
    const missing = join(repo, '.crosstalk', 'tokens', 'absent');

    // An empty string would reach the daemon and come back a 401 with nothing
    // to explain it, which is the failure mode this whole project keeps hitting.
    await expect(loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN_FILE: missing }))
      .rejects.toThrow(/could not be read/);

    const empty = join(repo, '.crosstalk', 'tokens', 'empty');
    await mkdir(join(repo, '.crosstalk', 'tokens'), { recursive: true });
    await writeFile(empty, '   \n', 'utf8');
    await expect(loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN_FILE: empty }))
      .rejects.toThrow(/is empty/);
  });
});

describe('mcp config', () => {
  it('discovers the url the daemon actually wrote, not one of its own', async () => {
    // The assertion that matters. A fixture would only prove this reader agrees
    // with itself; starting the real daemon proves it agrees with the writer.
    const repo = await tempRepo();
    const daemon = await startDaemon({ repo });
    try {
      const config = await loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN: 't' });
      expect(config.url).toBe(daemon.url);
      expect(config.token).toBe('t');
    } finally {
      await daemon.close();
    }
  });

  it('names `crosstalk up` when no daemon is running', async () => {
    const repo = await tempRepo();

    await expect(loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN: 't' })).rejects.toThrow(
      /crosstalk up/,
    );
  });

  it('fails rather than returning nothing when daemon.json is unreadable', async () => {
    const repo = await tempRepo('{ this is not json');

    const error = await loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN: 't' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/crosstalk (down|up)/);
  });

  it('fails when daemon.json carries no url', async () => {
    const repo = await tempRepo('{"version":1,"pid":1,"startedAt":"2026-08-10T00:00:00.000Z"}');

    await expect(loadMcpConfig({ CROSSTALK_REPO: repo, CROSSTALK_TOKEN: 't' })).rejects.toThrow(
      /url/,
    );
  });

  it('lets CROSSTALK_URL override discovery', async () => {
    const repo = await tempRepo('{"version":1,"url":"http://127.0.0.1:1","pid":1,"startedAt":"x"}');

    const config = await loadMcpConfig({
      CROSSTALK_REPO: repo,
      CROSSTALK_TOKEN: 't',
      CROSSTALK_URL: 'http://127.0.0.1:9999',
    });

    expect(config.url).toBe('http://127.0.0.1:9999');
  });

  it('names the command that writes .mcp.json when CROSSTALK_REPO is missing', async () => {
    await expect(loadMcpConfig({ CROSSTALK_TOKEN: 't' })).rejects.toThrow(/crosstalk init/);
  });

  it('explains why the token is per participant when it is missing', async () => {
    const repo = await tempRepo();
    await expect(loadMcpConfig({ CROSSTALK_REPO: repo })).rejects.toThrow(/CROSSTALK_TOKEN/);
  });
});
