import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGE_TAGS } from '../../src/contracts/say.js';
import { TAGS } from '../../src/core/says.js';
import { renderSkill, SKILL_FILE, writeBoardSkill } from '../../src/harness/skill.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('the generated board skill', () => {
  it('renders every tag the seat actually has', () => {
    const skill = renderSkill(['status', 'ask', 'answer']);
    expect(skill).toContain('`status`');
    expect(skill).toContain('`ask`');
    expect(skill).toContain('`answer`');
    // A builder has no `plan` tag; a skill that taught it would be teaching a
    // verb the daemon will refuse.
    expect(skill).not.toContain('`plan`');
  });

  it('says the same thing about a tag that the daemon enforces', () => {
    // Generated, never authored. An authored file is a fourth copy of the
    // vocabulary and the fourth copy is the one that goes stale.
    const skill = renderSkill([...MESSAGE_TAGS]);
    for (const tag of MESSAGE_TAGS) {
      expect(skill).toContain(TAGS[tag].need);
    }
  });

  it('names the fields a tag requires', () => {
    const skill = renderSkill(['ask', 'result']);
    // `ask` needs `to`, `result` needs `ref` — the requirements are what a
    // refusal will be about, so they belong in what the seat reads first.
    expect(skill).toContain('`to`');
    expect(skill).toContain('`ref`');
  });

  it('states no sizes at all', () => {
    // The rule the whole vocabulary rests on: the cap read `1500` in three
    // brief templates and the median message across 1187 events was 1429
    // characters. A writer told a number spends it.
    const skill = renderSkill([...MESSAGE_TAGS]);
    const numbers = skill.match(/\b\d{3,}\b/g);
    expect(numbers).toBeNull();
  });

  it('has the frontmatter a skill file needs to be found', () => {
    const skill = renderSkill(['status']);
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: crosstalk-board');
    expect(skill).toMatch(/description: .+/);
  });

  it('lands where Claude Code looks for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-skill-'));
    dirs.push(dir);

    const path = await writeBoardSkill({ repo: dir, workspace: '.', tags: ['status', 'ask'] });

    expect(path).toBe(join(dir, SKILL_FILE));
    expect(await readFile(path, 'utf8')).toContain('crosstalk-board');
  });
});
