import { createElement } from 'react';
import type { MirrorView } from '../state/useMirror.js';
import type { SessionsView } from '../state/useLaunch.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { HarnessMark } from '../marks/HarnessMark.js';
import { harnessKind } from '../marks/kind.js';

/**
 * The strip above the board: where this run is, and where its work is going.
 *
 * Modelled on the Environment panel in Codex, and for the same reason — the
 * facts that frame everything below (which phase, what is blocking it, whether
 * anything is reaching GitHub) were spread across three cards in a dock that
 * scrolls, so the operator learned them by hunting rather than by looking.
 *
 * It renders only what something can answer. The phase comes from
 * `GET /sessions`, the mirror from `GET /mirror`; neither is invented, and a
 * fact with no source is absent rather than shown as a dash.
 */
export interface EnvironmentRailProps {
  sessions?: SessionsView;
  mirror?: MirrorView;
  /** Opens a seat's terminal. Absent when nothing is mirrorable. */
  onOpenSession?: (seat: string) => void;
  openSeat?: string;
}

/**
 * Three states the operator acts on differently, and which looked identical
 * while the mirror had no surface: never set up, set up and not running,
 * running.
 */
function mirrorState(mirror: MirrorView): { label: string; state: string } {
  if (!mirror.configured) return { label: 'no mirror configured', state: 'off' };
  if (!mirror.enabled) return { label: 'mirror not running', state: 'stalled' };
  return { label: 'mirroring to GitHub', state: 'running' };
}

export function EnvironmentRail({ sessions, mirror, onOpenSession, openSeat }: EnvironmentRailProps) {
  const phase = sessions?.phase ?? undefined;
  const seats = sessions?.seats ?? [];

  return createElement(
    'section',
    { className: 'env-rail', 'aria-label': 'run environment', 'data-testid': 'env-rail' },

    phase === undefined
      ? null
      : createElement(
          'div',
          { className: 'env-block', 'data-testid': 'env-phase' },
          createElement('span', { className: 'env-label' }, 'PHASE'),
          createElement(
            'span',
            { className: 'env-value' },
            createElement('span', {
              className: 'gate-ring',
              'data-met': phase.complete ? 'true' : 'false',
              'aria-hidden': 'true',
            }),
            phase.id,
          ),
          // The gates that are not met, named. `phaseStatus` already formats
          // each as `gate-id — what is missing`, so the rail quotes it rather
          // than paraphrasing: a blocking line the operator can search the log
          // for is worth more than a tidier one they cannot.
          phase.blocking.length === 0
            ? createElement('span', { className: 'env-note' }, 'all gates met')
            : createElement(
                'span',
                { className: 'env-note', title: phase.blocking.join('\n') },
                phase.blocking[0],
                phase.blocking.length > 1
                  ? createElement('span', { className: 'count' }, ` +${phase.blocking.length - 1}`)
                  : null,
              ),
        ),

    seats.length === 0
      ? null
      : createElement(
          'div',
          { className: 'env-block env-seats', 'data-testid': 'env-seats' },
          createElement('span', { className: 'env-label' }, 'SEATS'),
          createElement(
            'div',
            { className: 'env-seat-row' },
            seats.map((seat) => {
              const openable = onOpenSession !== undefined && seat.mirrored === true;
              return createElement(
                openable ? 'button' : 'span',
                {
                  key: seat.id,
                  className: `env-seat${openSeat === seat.id ? ' is-open' : ''}`,
                  'data-harness': harnessKind(seat.harness),
                  'data-present': seat.present ? 'true' : 'false',
                  'data-testid': `env-seat-${seat.id}`,
                  ...(openable
                    ? {
                        type: 'button',
                        title: `Open ${seat.id}'s terminal`,
                        onClick: () => onOpenSession(seat.id),
                      }
                    : // Said, not implied: a seat started in someone's own shell
                      // is working fine and simply cannot be watched from here.
                      { title: `${seat.id} was not started from the hub, so it has no terminal to mirror` }),
                },
                createElement(HarnessMark, { harness: seat.harness, size: 13 }),
                createElement('span', { className: 'env-seat-id' }, seat.id),
                createElement('span', {
                  className: 'state-dot',
                  'data-state': seat.present ? 'running' : 'exited',
                  'aria-hidden': 'true',
                }),
              );
            }),
          ),
        ),

    mirror === undefined
      ? null
      : createElement(
          'div',
          { className: 'env-block env-mirror', 'data-testid': 'env-mirror' },
          createElement('span', { className: 'env-label' }, 'GITHUB'),
          createElement(
            'span',
            { className: 'state', 'data-state': mirrorState(mirror).state, 'data-testid': 'env-mirror-state' },
            createElement('span', { className: 'state-dot', 'aria-hidden': 'true' }),
            mirrorState(mirror).label,
          ),
          mirror.lastDrain === undefined
            ? null
            : createElement(
                'span',
                { className: 'env-note' },
                createElement('span', { className: 'count' }, String(mirror.lastDrain.completed)),
                ' pushed',
                mirror.lastDrain.retrying > 0
                  ? createElement(
                      'span',
                      { className: 'env-retry' },
                      ' · ',
                      createElement('span', { className: 'count' }, String(mirror.lastDrain.retrying)),
                      ' retrying',
                    )
                  : null,
              ),
          mirror.lastError === undefined
            ? null
            : createElement('span', { className: 'env-error', title: mirror.lastError }, mirror.lastError),
        ),
  );
}
