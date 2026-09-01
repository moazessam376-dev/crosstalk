import { createElement } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';
import type { Task } from '../../contracts/task.js';
import { project } from '../../core/projection.js';
import type { ChannelRoom, ParticipantStatus, ParticipantView } from '../state/derive.js';
import { assignColours, identityFor } from '../state/identity.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { HarnessMark } from '../marks/HarnessMark.js';
import { harnessKind } from '../marks/kind.js';
import { pullRequestState } from '../state/pullRequest.js';
import { HUMAN_ID } from '../../contracts/room.js';
import type { MirrorView } from '../state/useMirror.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ComposeForm } from './ComposeForm.js';

export interface DockProps {
  events: CrosstalkEvent[];
  participants: ParticipantView[];
  rooms: ChannelRoom[];
  activeRoom?: string;
  /** Who this browser posts as. Without it there is no id to build a room from. */
  self?: string;
  /** Absent without a daemon, which is when no control should render at all. */
  onOpenSideRoom?: (participantId: string) => void;
  onCompose?: (job: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Open a seat's mirrored CLI.
   *
   * Absent when nothing can be mirrored — a fixture hub, or a daemon that
   * started no sessions — and the row is then not a button. A control that
   * cannot work is the defect CT-10 is about.
   */
  onOpenSession?: (participantId: string) => void;
  /** Seats this daemon holds a terminal for, from `GET /sessions`. */
  mirrored?: ReadonlySet<string>;
  /** What to call the operator's own seat in the roster. */
  operator?: string;
  /**
   * The GitHub mirror, from `GET /mirror` rather than from the log — it has no
   * write path into the log and this hub does not give it one.
   *
   * `undefined` means "not asked yet", which is not "off": a card that said
   * "not configured" before the first response would be wrong on every load.
   */
  mirror?: MirrorView;
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

type Row = [string, string | ReturnType<typeof createElement>];

function rows(pairs: Row[]) {
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
/**
 * Three states that the operator acts on differently, and which looked
 * identical while the mirror had no surface: never set up, set up and not
 * running, running.
 */
function mirrorState(mirror: MirrorView): string {
  if (!mirror.configured) return 'not configured';
  return mirror.enabled ? 'running' : 'not running';
}

export function Dock({
  events,
  participants,
  rooms,
  activeRoom,
  self,
  onOpenSideRoom,
  onOpenSession,
  onCompose,
  mirror,
  mirrored,
  operator,
}: DockProps) {
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
    onCompose === undefined
      ? null
      : section('Compose', undefined, createElement(ComposeForm, { onStart: onCompose }), 'dock-compose'),
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
              // GitHub's semantics and GitHub's colours — purple for merged
              // above all, because that is the one every reader already knows.
              // Open was amber here, which reads as "needs attention" for what
              // is the healthy state of a pull request.
              ...(task.pr === undefined
                ? []
                : ([
                    [
                      'pr',
                      createElement(
                        'span',
                        { className: 'pr-state', 'data-pr': pullRequestState(task.state), 'data-testid': 'dock-pr' },
                        `#${task.pr} ${pullRequestState(task.state)}`,
                      ),
                    ],
                  ] as Row[])),
              ['assignee', task.assignee],
              ...(assignee === undefined ? [] : ([['worktree', assignee.workspace]] as Row[])),
            ] as Row[],
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
                  { className: 'member-avatar-wrap', 'data-harness': harnessKind(member.harness) },
                  createElement(HarnessMark, { harness: member.harness, size: 15, fallback: identity.initials }),
                  createElement('span', {
                    className: 'status-dot',
                    'data-status': member.status,
                    'aria-label': STATUS_TEXT[member.status],
                    title: STATUS_TEXT[member.status],
                    role: 'img',
                    'data-testid': `member-dot-${member.id}`,
                  }),
                ),
                // Clicking a seat opens its terminal. The board says what the
                // team decided; a seat spends minutes reading files between
                // messages, and during those minutes the board shows an agent
                // that has said nothing and looks stalled.
                createElement(
                  onOpenSession !== undefined && mirrored?.has(member.id) === true ? 'button' : 'span',
                  {
                    className: 'member-body',
                    ...(onOpenSession !== undefined && mirrored?.has(member.id) === true
                      ? {
                          type: 'button',
                          'data-testid': `open-session-${member.id}`,
                          title: `Open ${member.id}'s terminal`,
                          onClick: () => onOpenSession(member.id),
                        }
                      : {}),
                  },
                  createElement(
                    'span',
                    { className: 'member-line' },
                    createElement(
                      'span',
                      { className: 'member-id' },
                      operator !== undefined && member.id === (self ?? HUMAN_ID) ? operator : member.id,
                    ),
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
    // The mirror moved to the environment rail, which is where the facts that
    // frame a whole run belong. Two surfaces reporting one status is two
    // vocabularies for one fact, and the operator has to learn which is
    // authoritative — so the dock stopped saying it.
  );
}
