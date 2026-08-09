import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../../src/core/log.js';

const trackedLogs: EventLog[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(trackedLogs.splice(0).map((log) => log.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-'));
  tempDirs.push(dir);
  return dir;
}

async function openTrackedLog(path: string): Promise<EventLog> {
  const log = await EventLog.open(path);
  trackedLogs.push(log);
  return log;
}

describe('EventLog', () => {
  it('closes its file handle', async () => {
    const dir = await makeTempDir();
    const log = await EventLog.open(join(dir, 'events.jsonl'));

    await expect(log.close()).resolves.toBeUndefined();
  });
  it('assigns monotonic seq starting at 1', async () => {
    const dir = await makeTempDir();
    const log = await openTrackedLog(join(dir, 'events.jsonl'));
    const a = await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'one' });
    const b = await log.append({ kind: 'message', from: 'codex', room: '#floor', body: 'two' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('writes LF-terminated lines regardless of platform', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'events.jsonl');
    const log = await openTrackedLog(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const raw = await readFile(path, 'latin1');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });

  it('resumes seq after reopening an existing log', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'events.jsonl');
    const first = await openTrackedLog(path);
    await first.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const second = await openTrackedLog(path);
    const next = await second.append({ kind: 'message', from: 'leader', room: '#floor', body: 'y' });
    expect(next.seq).toBe(2);
  });

  it('tolerates a truncated final line and truncates to the last valid seq', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'events.jsonl');
    const log = await openTrackedLog(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'good' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"seq":2,"kind":"mess');
    const recovered = await openTrackedLog(path);
    expect(recovered.lastSeq).toBe(1);
    expect((await recovered.read())).toHaveLength(1);
  });

  it('preserves in-memory history from caller mutation across append and reads', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'events.jsonl');
    const log = await openTrackedLog(path);
    const appended = await log.append({
      kind: 'task_created',
      from: 'leader',
      task: {
        id: 'T-01',
        title: 'Original title',
        brief: 'Brief',
        specRefs: ['docs/spec.md'],
        assignee: 'codex',
        deps: [],
        acceptance: ['one'],
        state: 'draft',
        branch: 'ct/T-01',
      },
    });

    if (appended.kind !== 'task_created') {
      throw new Error('Expected task_created event');
    }
    appended.seq = 999;
    appended.task.title = 'Mutated append result';

    const readEvents = await log.read();
    const readEvent = readEvents[0];
    if (readEvent?.kind !== 'task_created') {
      throw new Error('Expected task_created event in read result');
    }
    readEvent.task.title = 'Mutated read result';

    const readFromEvents = await log.readFrom(1);
    const readFromEvent = readFromEvents[0];
    if (readFromEvent?.kind !== 'task_created') {
      throw new Error('Expected task_created event in readFrom result');
    }
    readFromEvent.task.title = 'Mutated readFrom result';

    const laterRead = await log.read();
    const taskCreated = laterRead[0];
    if (taskCreated?.kind !== 'task_created') {
      throw new Error('Expected task_created event in later read result');
    }
    expect(taskCreated?.seq).toBe(1);
    expect(taskCreated?.kind).toBe('task_created');
    expect(taskCreated?.task.title).toBe('Original title');
  });
  it('serializes concurrent appends and resumes seq after reopening', async () => {
    for (let round = 0; round < 25; round += 1) {
    const dir = await makeTempDir();
    const path = join(dir, 'events.jsonl');
    const log = await openTrackedLog(path);
    const count = 100;

    const appended = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        log.append({
          kind: 'message',
          from: 'leader',
          room: '#floor',
          body: 'message-' + index + '-' + 'x'.repeat(16_384),
        }),
      ),
    );

    const expected = Array.from({ length: count }, (_, index) => index + 1);
    expect(appended.map((event) => event.seq)).toEqual(expected);

    const reopened = await openTrackedLog(path);
    expect((await reopened.read()).map((event) => event.seq)).toEqual(expected);

    const next = await reopened.append({
      kind: 'message',
      from: 'leader',
      room: '#floor',
      body: 'after-reopen',
    });
    expect(next.seq).toBe(count + 1);
    }
  }, 30_000);
});
