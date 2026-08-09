import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../../src/core/log.js';

describe('EventLog', () => {
  it('assigns monotonic seq starting at 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const log = await EventLog.open(join(dir, 'events.jsonl'));
    const a = await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'one' });
    const b = await log.append({ kind: 'message', from: 'codex', room: '#floor', body: 'two' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('writes LF-terminated lines regardless of platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.open(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const raw = await readFile(path, 'latin1');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });

  it('resumes seq after reopening an existing log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const first = await EventLog.open(path);
    await first.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const second = await EventLog.open(path);
    const next = await second.append({ kind: 'message', from: 'leader', room: '#floor', body: 'y' });
    expect(next.seq).toBe(2);
  });

  it('tolerates a truncated final line and truncates to the last valid seq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.open(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'good' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"seq":2,"kind":"mess');
    const recovered = await EventLog.open(path);
    expect(recovered.lastSeq).toBe(1);
    expect((await recovered.read())).toHaveLength(1);
  });
});
