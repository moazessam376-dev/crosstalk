import { createElement } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';
import type { Task } from '../../contracts/task.js';
import { project } from '../../core/projection.js';
import type { ChannelRoom, ParticipantStatus, ParticipantView } from '../state/derive.js';
import { assignColours, identityFor } from '../state/identity.js';

export interface DockProps {
  events: CrosstalkEvent[];
  participants: ParticipantView[];
  rooms: ChannelRoom[];
  activeRoom?: string;
}

const STATUS_GROUPS: readonly { key: ParticipantStatus; label: string }[] = [
  { key: 'working', label: 'WORKING' },
  { key: 'awaiting_turn', label: 'AWAITING TURN' },
  { key: 'offline', label: 'OFFLINE' },
];

/** A colour is not a status to a screen reader. */
const STATUS_TEXT: Record<ParticipantStatus, string> = {
  working: 'working',
  awaiting_turn: 'awaiting turn',
  offline: 'offline',
};

function taskFor(events: readonly CrosstalkEvent[], activeRoom: string | undefined): Task | undefined {
  if (activeRoom === undefined || !activeRoom.startsWith('task:')) return undefined;
  return project([...events]).tasks.get(activeRoom.slice('task:'.length));
}

function section(
  title: string,
  aside: string | undefined,
  body: ReturnType<typeof createElement>,
  testId: string,
) {
  return createElement(
    'section',
    { className: 'dock-card', 'data-testid': testId },
    createElement(
      'header',
      { className: 'dock-card-head' },
      createElement('span', { className: 'dock-card-title' }, title),
      aside === undefined ? null : createElement('span', { className: 'dock-card-aside fact' }, aside),
    ),
    body,
  );
}

function rows(pairs: [string, string][]) {
  return createElement(
    'dl',
    { className: 'dock-rows' },
    pairs.flatMap(([label, value]) => [
      createElement('dt', { key: `${label}-t` }, label),
      createElement('dd', { key: `${label}-d`, className: 'fact' }, value),
    ]),
  );
}

/**
 * The right dock: what room you are in, what work it is attached to, and who is
 * here.
 *
 * The design's Workspace card also shows a diff stat, a commit, a check count
 * and a per-OS row. None of those are in the log — the hub is a projection of
 * events (§10) and no event carries them, so they are not rendered rather than
 * invented. What a task genuinely carries is its branch, its PR number and its
 * assignee's workspace, and that is what shows.
 */
export function Dock({ events, participants, rooms, activeRoom }: DockProps) {
  const room = rooms.find((candidate) => candidate.id === activeRoom);
  const scoped = activeRoom === undefined ? [] : events.filter((event) => event.room === activeRoom);
  const lastSeq = scoped.at(-1)?.seq;
  const task = taskFor(events, activeRoom);
  const assignee = task ? participants.find((participant) => participant.id === task.assignee) : undefined;

  const colours = assignColours(participants.map((participant) => participant.id));

  const groups = STATUS_GROUPS.map((group) => ({
    ...group,
    members: participants.filter((participant) => participant.status === group.key),
  })).filter((group) => group.members.length > 0);

  return createElement(
    'aside',
    { className: 'hub-region hub-dock', 'aria-label': 'inspector', 'data-testid': 'hub-region' },
    section(
      'Room',
      room?.kind,
      rows([
        ['id', activeRoom ?? '—'],
        ['events', String(scoped.length)],
        ['last seq', lastSeq === undefined ? '—' : `#${lastSeq}`],
      ]),
      'dock-room',
    ),
    task === undefined
      ? null
      : section(
          'Workspace',
          task.state,
          rows(
            [
              ['branch', task.branch],
              ...(task.pr === undefined ? [] : ([['pr', `#${task.pr}`]] as [string, string][])),
              ['assignee', task.assignee],
              ...(assignee === undefined ? [] : ([['worktree', assignee.workspace]] as [string, string][])),
            ] as [string, string][],
          ),
          'dock-workspace',
        ),
    section(
      'Participants',
      String(participants.length),
      createElement(
        'div',
        { className: 'dock-members' },
        groups.map((group) =>
          createElement(
            'div',
            { key: group.key, className: 'member-group' },
            createElement('div', { className: 'member-group-label' }, `${group.label} — ${group.members.length}`),
            group.members.map((member) => {
              const identity = identityFor(member.id, {
                id: member.id,
                role: member.role,
                harness: member.harness,
                model: member.model,
                lifecycle: 'attached',
                workspace: member.workspace,
                transport: member.tier,
              }, colours.get(member.id));
              return createElement(
                'div',
                {
                  key: member.id,
                  className: 'member-row',
                  'data-status': member.status,
                  'data-testid': `member-${member.id}`,
                },
                createElement(
                  'span',
                  { className: 'member-avatar-wrap' },
                  createElement(
                    'span',
                    { className: 'avatar avatar-md', style: { background: identity.colour }, 'aria-hidden': 'true' },
                    identity.initials,
                  ),
                  createElement('span', {
                    className: 'status-dot',
                    'data-status': member.status,
                    'aria-label': STATUS_TEXT[member.status],
                    title: STATUS_TEXT[member.status],
                    role: 'img',
                    'data-testid': `member-dot-${member.id}`,
                  }),
                ),
                createElement(
                  'span',
                  { className: 'member-body' },
                  createElement(
                    'span',
                    { className: 'member-line' },
                    createElement('span', { className: 'member-id' }, member.id),
                    createElement('span', { className: 'member-role' }, member.role),
                  ),
                  // `harness · model · tier`, with whatever the log omits left
                  // out. The design also shows an effort level; no contract
                  // field carries one, so there is nothing to read.
                  createElement('span', { className: 'member-meta fact' }, identity.meta || '—'),
                ),
              );
            }),
          ),
        ),
      ),
      'dock-participants',
    ),
  );
}
