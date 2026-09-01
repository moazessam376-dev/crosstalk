import { createElement, useLayoutEffect, useRef } from 'react';
import type { Claim } from '../../contracts/claim.js';
import type { CrosstalkEvent } from '../../contracts/events.js';
import { HUMAN_ID } from '../../contracts/room.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ClaimCard } from '../cards/ClaimCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { MessageCard } from '../cards/MessageCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ProtocolCard } from '../cards/ProtocolCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { TaskCard } from '../cards/TaskCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Composer } from './Composer.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { DisputeView } from '../dispute/DisputeView.js';
import type { ChannelRoom, ParticipantView } from '../state/derive.js';
import { assignColours } from '../state/identity.js';
import type { PostResult } from '../state/humanAction.js';

export type HumanAction = { type: 'propose_test' | 'intervene_human' };

export interface StreamProps {
  events: CrosstalkEvent[];
  activeRoom?: string;
  rooms?: ChannelRoom[];
  participants?: ParticipantView[];
  /** `policy.dispute.maxRounds`, passed through to the dispute header. */
  maxRounds?: number;
  /** Who the daemon attributes this browser's posts to. */
  self?: string;
  /** What to call the operator's own seat. Absent until they have named it. */
  operator?: string;
  /** `live`, `connecting` or `reconnecting`. Fixture mode never renders a stream. */
  status?: string;
  onSend?: (body: string) => Promise<PostResult>;
  onVote?: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
  onHumanAction?: (action: HumanAction) => void;
  /**
   * Rendered but not shown, while a seat's terminal has the centre column.
   *
   * The board is hidden rather than unmounted so its scroll position, every
   * expanded message and any half-written composer draft are still there when
   * the operator comes back.
   */
  hidden?: boolean;
}

const ICONS: Record<string, string> = { floor: '#', task: '◇', dispute: '⚔', direct: '@' };

/**
 * The first participant a message actually addresses.
 *
 * Matched against the roster rather than any `@word`, so a stray address in
 * prose does not sprout a routing pill that routes nowhere.
 */
function mentionIn(body: string, roster: Map<string, ParticipantView>): string | undefined {
  for (const id of roster.keys()) {
    const handle = id.startsWith('@') ? id : `@${id}`;
    if (body.includes(handle)) return handle;
  }
  return undefined;
}

function kindOf(roomId: string | undefined): string {
  if (roomId === undefined) return 'floor';
  if (roomId === '#floor') return 'floor';
  if (roomId.startsWith('task:')) return 'task';
  if (roomId.startsWith('dispute:')) return 'dispute';
  return 'direct';
}

/**
 * How close to the bottom still counts as being at the bottom.
 *
 * A reader who has scrolled up by a line is still reading the end and wants the
 * next message; one who has scrolled up by a screen is reading something and
 * must not be yanked away from it.
 */
const STICK_SLACK_PX = 40;

/**
 * Remember where the operator was, per room.
 *
 * Nothing in the hub restored a scroll position, which had three separate
 * symptoms and one cause. A freshly mounted stream sat at `scrollTop = 0` — the
 * oldest event in the room, and on a run of 1187 events a very long way from
 * anything current. Switching rooms carried the previous room's offset over and
 * let the browser clamp it. And new events arriving over SSE never scrolled at
 * all, so a message could land below the fold in silence.
 *
 * Hiding matters here too: the board is now hidden rather than unmounted while
 * a seat's terminal has the centre column, and a `display: none` element has
 * its `scrollTop` reset to zero by the browser. The offset is therefore kept in
 * a ref that is written on every scroll, not read back off the element when it
 * is time to restore.
 */
function useStreamScroll(room: string, hidden: boolean, depth: number) {
  const scroller = useRef<{ scrollTop: number; scrollHeight: number; clientHeight: number } | null>(null);
  const offsets = useRef(new Map<string, number>());
  const shown = useRef<string | undefined>(undefined);
  const stick = useRef(true);

  const remember = (): void => {
    const el = scroller.current;
    if (el === null || hidden) return;
    offsets.current.set(room, el.scrollTop);
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || hidden) {
      // Leaving `shown` alone: coming back from a terminal has to look like
      // arriving in the room again, so the saved offset is put back.
      shown.current = undefined;
      return;
    }

    if (shown.current !== room) {
      const saved = offsets.current.get(room);
      // A room never opened before starts at the newest message, not the
      // oldest. That is what "open the room" means.
      el.scrollTop = saved ?? el.scrollHeight;
      stick.current = saved === undefined;
      shown.current = room;
      return;
    }

    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [room, hidden, depth]);

  return { scroller, remember };
}

export function Stream({
  events,
  activeRoom,
  rooms,
  participants,
  maxRounds,
  self,
  operator,
  status = 'live',
  onSend,
  onVote,
  onHumanAction,
  hidden,
}: StreamProps) {
  const visibleEvents = (activeRoom ? events.filter((event) => event.room === activeRoom) : events)
    .slice()
    .sort((left, right) => left.seq - right.seq);
  // Depth, not the array: a re-render that changed nothing about the log must
  // not move the operator, and the whole log is re-projected and re-sorted on a
  // two-second timer.
  const { scroller, remember } = useStreamScroll(activeRoom ?? '#floor', hidden === true, visibleEvents.length);
  const claims = new Map<string, Claim>();
  const staleShas = new Set<string>();
  const roster = new Map((participants ?? []).map((participant) => [participant.id, participant]));
  const colours = assignColours((participants ?? []).map((participant) => participant.id));

  for (const event of events) {
    if (event.kind === 'claim_raised') claims.set(event.claim.id, event.claim);
    if (event.kind === 'evidence_stale') staleShas.add(event.sha);
  }

  const kind = kindOf(activeRoom);
  const room = rooms?.find((candidate) => candidate.id === activeRoom);
  const isDispute = Boolean(activeRoom && activeRoom.startsWith('dispute:'));

  const cards = visibleEvents.map((event) => {
    if (event.kind === 'message') {
      const author = roster.get(event.from);
      return createElement(MessageCard, {
        key: String(event.seq) + '-' + event.kind,
        from: event.from,
        body: event.body,
        ...(event.head === undefined ? {} : { head: event.head }),
        ...(event.tag === undefined ? {} : { tag: event.tag }),
        ts: event.ts,
        seq: event.seq,
        role: author?.role,
        model: author?.model,
        harness: author?.harness,
        tier: author?.tier,
        colour: colours.get(event.from),
        ...(operator !== undefined && event.from === (self ?? HUMAN_ID) ? { displayName: operator } : {}),
        mention: mentionIn(event.body, roster),
        testId: 'card-message-' + event.seq,
      });
    }

    // design:216-238 — a task room shows the task. This used to fall through to
    // ProtocolCard's default branch and render as "unsupported event", with the
    // acceptance list, branch and gates all present in the log and none of them
    // on screen.
    if (event.kind === 'task_created') {
      return createElement(TaskCard, { key: String(event.seq) + '-' + event.kind, task: event.task });
    }

    if (event.kind === 'claim_raised') {
      return createElement(ClaimCard, {
        key: String(event.seq) + '-' + event.kind,
        claim: event.claim,
        staleShas,
        testId: 'card-claim-' + event.claim.id,
      });
    }

    if (event.kind === 'claim_response') {
      const claim = claims.get(event.claimId);
      if (claim) {
        return createElement(ClaimCard, {
          key: String(event.seq) + '-' + event.kind,
          claim,
          response: {
            from: event.from,
            verdict: event.verdict,
            rationale: event.rationale,
            falsifier: event.falsifier,
            evidence: event.evidence,
          },
          staleShas,
          showControls: false,
          testId: 'card-claim-response-' + event.seq,
        });
      }
    }

    return createElement(ProtocolCard, { key: String(event.seq) + '-' + event.kind, event });
  });

  return createElement(
    'section',
    {
      className: 'hub-region hub-stream',
      'aria-label': 'event stream',
      'data-testid': 'hub-region',
      'data-region': 'stream',
      ...(hidden === true ? { hidden: true } : {}),
    },
    createElement(
      'header',
      { className: 'stream-head' },
      createElement('span', { className: 'stream-icon', 'aria-hidden': 'true' }, ICONS[kind] ?? '#'),
      createElement('h2', { className: 'stream-title' }, activeRoom ?? 'Stream'),
      createElement('span', { className: 'stream-sub fact' }, `${visibleEvents.length} events`),
      createElement(
        'span',
        { className: 'stream-status', 'data-status': status, 'data-testid': 'stream-status' },
        createElement('span', { className: 'status-dot', 'data-status': status }),
        createElement('span', { className: 'fact' }, status),
      ),
    ),
    createElement(
      'div',
      {
        className: 'stream-scroll',
        'data-testid': 'stream-scroll',
        ref: scroller,
        onScroll: remember,
      },
      // An empty room is a first run, not a fault — the design says so on the
      // screen rather than leaving a blank panel.
      visibleEvents.length === 0 && !isDispute
        ? createElement(
            'div',
            { className: 'first-run', 'data-testid': 'first-run' },
            createElement('span', { className: 'fact-label' }, 'FIRST RUN'),
            createElement('p', { className: 'first-run-lead' }, `Nothing has been said in ${activeRoom ?? 'this room'} yet.`),
            createElement(
              'p',
              { className: 'first-run-note' },
              self === undefined
                ? 'Start an agent, or post the first message below.'
                : `Connected as ${operator ?? self}. Start an agent, or post the first message below.`,
            ),
          )
        : null,
      isDispute
        ? createElement(DisputeView, { roomId: activeRoom!, events, maxRounds, self, onVote, onHumanAction })
        : createElement('div', { className: 'card-stream' }, cards),
    ),
    // §10.1: anything awaiting a human decision is called out rather than left
    // to be noticed in a list.
    room?.awaitingHuman
      ? createElement(
          'div',
          { className: 'needs-you', 'data-testid': 'needs-you' },
          createElement('span', { className: 'needs-you-label' }, 'NEEDS YOU'),
          createElement(
            'span',
            { className: 'needs-you-body' },
            'A decision in this room is waiting on @human.',
          ),
        )
      : null,
    // §10.3: a composer on every room, disputes included.
    activeRoom && onSend ? createElement(Composer, { room: activeRoom, self, operator, onSend }) : null,
  );
}
