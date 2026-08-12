import { createElement } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';
import type { Task } from '../../contracts/task.js';
import { project } from '../../core/projection.js';
import type { ChannelRoom, ParticipantStatus, ParticipantView } from '../state/derive.js';
import { assignColours, identityFor } from '../state/identity.js';
import { HUMAN_ID } from '../../contracts/room.js';

export interface DockProps {
  events: CrosstalkEvent[];
  participants: ParticipantView[];
  rooms: ChannelRoom[];
  activeRoom?: string;
  /** Who this browser posts as. Without it there is no id to build a room from. */
  self?: string;
  /** Absent without a daemon, which is when no control should render at all. */
  onOpenSideRoom?: (participantId: string) => void;
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
export function Dock({ events, participants, rooms, activeRoom, self, onOpenSideRoom }: DockProps) {
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
                effort: member.effort,
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
                  // `harness · model effort · tier`, with whatever the log omits
                  // left out. Effort arrived with claim CT-A; this comment used
                  // to say the design's fourth fact had no field to read.
                  createElement('span', { className: 'member-meta fact' }, identity.meta || '—'),
                ),
                // CT-18. Side rooms have been a first-class room kind all
                // along and the sidebar already renders a DIRECT group for
                // them; nothing anywhere opened one, so the group was always
                // empty and the feature invisible. This is the surface that
                // creates one.
                //
                // Not offered against yourself, and not for `@human`, who is in
                // every room already.
                onOpenSideRoom === undefined || self === undefined || member.id === self || member.id === HUMAN_ID
                  ? null
                  : createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'member-side-room',
                        'data-testid': `side-room-${member.id}`,
                        // Said plainly, because `withHuman()` puts @human in
                        // every room and calling these DMs would imply privacy
                        // the tool deliberately does not offer.
                        title: `Open a side room with ${member.id} (@human is in it too)`,
                        'aria-label': `Open a side room with ${member.id}`,
                        onClick: () => onOpenSideRoom(member.id),
                      },
                      '@',
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
