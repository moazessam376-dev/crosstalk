import { createElement, useState } from 'react';
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
  /**
   * Point the mirror at a repository.
   *
   * Absent in a hub with no daemon behind it. Present, the rail grows a field:
   * the measured reason nobody ever configured the mirror is that the only way
   * to do it was a terminal command against an undocumented YAML block, while
   * the hub showed "no mirror configured" and offered nothing.
   */
  onConfigureMirror?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
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

export function EnvironmentRail({
  sessions,
  mirror,
  onOpenSession,
  openSeat,
  onConfigureMirror,
}: EnvironmentRailProps) {
  const phase = sessions?.phase ?? undefined;
  const seats = sessions?.seats ?? [];
  const [repoUrl, setRepoUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [mirrorNotice, setMirrorNotice] = useState<string | undefined>();

  const configure = async (): Promise<void> => {
    const url = repoUrl.trim();
    if (url === '' || saving || onConfigureMirror === undefined) return;
    setSaving(true);
    const result = await onConfigureMirror(url);
    setSaving(false);
    if (result.ok) {
      setRepoUrl('');
      setMirrorNotice(undefined);
      return;
    }
    setMirrorNotice(result.reason ?? 'the daemon refused it');
  };

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
              // What the supervisor said about this seat's health.
              //
              // It has always been on the roster and never drawn. Those notices
              // used to be posted to `#floor` under the operator's name instead
              // — 622 of the vault run's 1187 events — and moving them to
              // presence was only half the repair: a fact nobody renders is
              // still a fact nobody has.
              const blocked = seat.activity?.blocked;
              const state = blocked !== undefined ? 'stalled' : seat.present ? 'running' : 'exited';
              const title =
                blocked !== undefined
                  ? `${seat.id} ${blocked}`
                  : openable
                    ? `Open ${seat.id}'s terminal`
                    : // Said, not implied: a seat started in someone's own shell
                      // is working fine and simply cannot be watched from here.
                      `${seat.id} was not started from the hub, so it has no terminal to mirror`;
              return createElement(
                openable ? 'button' : 'span',
                {
                  key: seat.id,
                  className: `env-seat${openSeat === seat.id ? ' is-open' : ''}${blocked === undefined ? '' : ' is-blocked'}`,
                  'data-harness': harnessKind(seat.harness),
                  'data-present': seat.present ? 'true' : 'false',
                  ...(blocked === undefined ? {} : { 'data-blocked': 'true' }),
                  'data-testid': `env-seat-${seat.id}`,
                  title,
                  ...(openable ? { type: 'button', onClick: () => onOpenSession(seat.id) } : {}),
                },
                createElement(HarnessMark, { harness: seat.harness, size: 13 }),
                createElement('span', { className: 'env-seat-id' }, seat.id),
                createElement('span', {
                  className: 'state-dot',
                  'data-state': state,
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
          // The field, and only while there is nothing configured: a repo URL
          // box beside a working mirror is a way to point it somewhere else by
          // accident.
          mirror.configured || onConfigureMirror === undefined
            ? null
            : createElement(
                'form',
                {
                  className: 'env-mirror-setup',
                  'data-testid': 'env-mirror-setup',
                  onSubmit: (event: { preventDefault(): void }) => {
                    event.preventDefault();
                    void configure();
                  },
                },
                createElement('input', {
                  className: 'env-mirror-url',
                  'data-testid': 'env-mirror-url',
                  'aria-label': 'GitHub repository to mirror to',
                  placeholder: 'Paste a GitHub repo URL',
                  value: repoUrl,
                  autoComplete: 'off',
                  spellCheck: false,
                  onChange: (event: { target: { value: string } }) => setRepoUrl(event.target.value),
                }),
                createElement(
                  'button',
                  {
                    type: 'submit',
                    className: 'env-mirror-save',
                    'data-testid': 'env-mirror-save',
                    disabled: saving || repoUrl.trim() === '',
                  },
                  saving ? 'Setting up' : 'Mirror',
                ),
              ),
          mirrorNotice === undefined
            ? null
            : createElement(
                'span',
                { className: 'env-note env-mirror-notice', role: 'alert', 'data-testid': 'env-mirror-notice' },
                mirrorNotice,
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
