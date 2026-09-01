import { describe, expect, it, beforeEach } from 'vitest';

import { claudeAliases, discoverModels, forgetModels } from '../../src/harness/models.js';
import { findExecutable } from '../../src/harness/path.js';

/**
 * What a harness can be put on, asked rather than assumed.
 *
 * The registry shipped a hand-written list. It said `gpt-5.3-codex`; the
 * operator's Codex offers luna, terra and sol at 5.6. A list that looks
 * authoritative and cannot be chosen from is worse than no list, so the source
 * of truth is the binary, and everything falls back to free text.
 */

beforeEach(forgetModels);

describe('reading Claude Code aliases out of its own help', () => {
  /** The real sentence, from `claude --help` on 2026-09-01. */
  const HELP = `
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

  it('takes the CLI at its own word', () => {
    expect(claudeAliases(HELP)).toEqual(['fable', 'opus', 'sonnet', 'claude-fable-5']);
  });

  it('stops at the next flag rather than swallowing the whole help', () => {
    expect(claudeAliases(HELP)).not.toContain('name');
  });

  it('says nothing when there is no such flag', () => {
    expect(claudeAliases('Usage: something --help')).toEqual([]);
  });
});

describe('the model catalogue', () => {
  it('falls back to what the registry lists when nothing can be probed', async () => {
    const catalogue = await discoverModels('made-up', { models: ['a', 'b'], spawn: undefined });
    expect(catalogue.source).toBe('registry');
    expect(catalogue.models.map((model) => model.id)).toEqual(['a', 'b']);
  });

  it('answers empty rather than inventing a list', async () => {
    const catalogue = await discoverModels('bare', { models: undefined, spawn: undefined });
    expect(catalogue.source).toBe('none');
    expect(catalogue.models).toEqual([]);
  });

  it('falls back rather than throwing when the binary is not there', async () => {
    const catalogue = await discoverModels('ghost', {
      models: ['fallback'],
      spawn: ['definitely-not-a-real-binary-9f3a'],
    });
    expect(catalogue.source).toBe('registry');
    expect(catalogue.models.map((model) => model.id)).toEqual(['fallback']);
  });

  it('caches, so opening the launcher does not respawn a CLI per click', async () => {
    const first = await discoverModels('cached', { models: ['x'], spawn: undefined }, 1_000);
    const second = await discoverModels('cached', { models: ['y'], spawn: undefined }, 1_500);
    expect(second.models).toEqual(first.models);

    const later = await discoverModels('cached', { models: ['y'], spawn: undefined }, 10 ** 9);
    expect(later.models.map((model) => model.id)).toEqual(['y']);
  });
});

describe('against the CLIs actually installed here', () => {
  it('reads Codex models off the binary, efforts included', async () => {
    if ((await findExecutable('codex')) === undefined) return; // Not installed: untestable, not false.

    const catalogue = await discoverModels('codex-cli', { models: ['stale'], spawn: ['codex', 'exec'] });
    expect(catalogue.source).toBe('binary');
    expect(catalogue.models.length).toBeGreaterThan(0);
    // The hand-written list is not what comes back.
    expect(catalogue.models.map((model) => model.id)).not.toContain('stale');
    // Codex names the efforts each model takes — which no hand-written list
    // ever carried, and which is why `max` could not be chosen.
    const withEfforts = catalogue.models.find((model) => (model.efforts?.length ?? 0) > 0);
    expect(withEfforts).toBeDefined();
    expect(withEfforts?.efforts).toContain('high');
  }, 20_000);

  it('reads Claude Code aliases off the binary', async () => {
    if ((await findExecutable('claude')) === undefined) return;

    const catalogue = await discoverModels('claude-code-live', { models: [], spawn: ['claude'] });
    expect(catalogue.source).toBe('help');
    expect(catalogue.models.length).toBeGreaterThan(0);
  }, 20_000);
});
