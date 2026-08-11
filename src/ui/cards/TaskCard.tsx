import { createElement } from 'react';
import type { Task } from '../../contracts/task.js';

export interface TaskCardProps {
  task: Task;
  testId?: string;
}

/**
 * A task, in the room that is about it.
 *
 * Before this, a task room's `task_created` fell through to `ProtocolCard`'s
 * default branch and rendered as "unsupported event" — the acceptance list, the
 * branch and the gates were all in the log and none of them were on screen.
 *
 * The design's footer also shows two gate ticks. They are real: `acknowledgement`
 * is gate 1 and `critique` is gate 2, both optional on `Task`, so each renders
 * as met or not rather than as a decoration.
 */
export function TaskCard({ task, testId = `card-task-${task.id}` }: TaskCardProps) {
  return createElement(
    'article',
    { className: 'task-card', 'data-card-kind': 'task', 'data-task-state': task.state, 'data-testid': testId },
    createElement(
      'header',
      { className: 'task-card-head' },
      createElement('span', { className: 'task-eyebrow' }, 'TASK'),
      createElement('span', { className: 'task-id' }, task.id),
      createElement('span', { className: 'task-title' }, task.title),
      createElement('span', { className: `state-chip state-${task.state}` }, task.state),
    ),
    task.brief ? createElement('p', { className: 'task-brief' }, task.brief) : null,
    task.acceptance.length === 0
      ? null
      : createElement(
          'div',
          { className: 'task-acceptance' },
          createElement('span', { className: 'fact-label' }, 'ACCEPTANCE'),
          createElement(
            'ul',
            null,
            task.acceptance.map((line, index) => createElement('li', { key: index }, line)),
          ),
        ),
    createElement(
      'div',
      { className: 'task-foot' },
      createElement('span', null, `branch ${task.branch}`),
      task.pr === undefined ? null : createElement('span', null, `PR #${task.pr}`),
      createElement('span', null, `gate 1 ${task.acknowledgement ? '✓' : '·'} ack`),
      createElement('span', null, `gate 2 ${task.critique ? '✓' : '·'} self-review`),
    ),
  );
}
