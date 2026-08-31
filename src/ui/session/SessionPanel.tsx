import { createElement, useState } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { HarnessMark } from '../marks/HarnessMark.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Terminal } from './Terminal.js';
import { postSessionInput, useSessionMirror } from '../state/useSessionMirror.js';
import type { SeatSession } from '../state/useLaunch.js';

const ESC = '\u001b';

/** Label, the bytes a real keyboard sends, and the name for a screen reader. */
const KEYS: readonly [string, string, string][] = [
  ['\u2191', `${ESC}[A`, 'up'],
  ['\u2193', `${ESC}[B`, 'down'],
  ['\u21b5', '\r', 'return'],
  ['esc', ESC, 'escape'],
];

export interface SessionPanelProps {
  seat: SeatSession;
  onClose: () => void;
}

/**
 * One agent's CLI, mirrored, with a way to talk to that agent alone.
 *
 * The board answers "what did the team decide"; this answers "what is opus
 * doing right now", which the log structurally cannot — a seat spends minutes
 * reading files between messages, and during those minutes the board shows an
 * agent that has said nothing and looks stalled. Both times the bench lost an
 * hour, that was the shape of it.
 *
 * The composer here is deliberately *not* a `say`. A message on the floor is
 * addressed to the team and lands in everyone's inbox; this types into one
 * agent's terminal and no one else sees it. Two different acts, so two
 * different surfaces — putting them behind one control is how an operator ends
 * up broadcasting a note they meant for one seat.
 */
export function SessionPanel({ seat, onClose }: SessionPanelProps) {
  const mirror = useSessionMirror(seat.id);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const press = async (bytes: string, label: string): Promise<void> => {
    const result = await postSessionInput(seat.id, { keys: bytes });
    setNotice(result.ok ? undefined : (result.reason ?? `the daemon refused ${label}`));
  };

  const send = async (): Promise<void> => {
    const turn = draft.trim();
    if (turn === '' || sending) return;
    setSending(true);
    const result = await postSessionInput(seat.id, { turn });
    setSending(false);
    if (result.ok) {
      setDraft('');
      setNotice(undefined);
      return;
    }
    setNotice(result.reason ?? 'the daemon refused it');
  };

  const state = mirror === undefined
    ? 'connecting'
    : mirror.unavailable !== undefined
      ? 'unmirrored'
      : mirror.running
        ? 'running'
        : 'exited';

  return createElement(
    'section',
    { className: 'session-panel', 'data-testid': 'session-panel', 'data-seat': seat.id, 'data-state': state },
    createElement(
      'header',
      { className: 'session-head' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'session-back',
          onClick: onClose,
          'aria-label': 'Back to the board',
          'data-testid': 'session-back',
        },
        '←',
      ),
      createElement(
        'span',
        { className: 'session-mark', 'data-harness': seat.harness },
        createElement(HarnessMark, { harness: seat.harness, size: 16 }),
      ),
      createElement(
        'span',
        { className: 'session-title' },
        createElement('span', { className: 'session-id' }, seat.id),
        createElement('span', { className: 'session-role' }, seat.role),
      ),
      createElement(
        'span',
        { className: 'session-meta fact' },
        [seat.model, seat.effort].filter(Boolean).join(' ') || seat.harness,
      ),
      createElement(
        'span',
        { className: 'session-state', 'data-state': state },
        createElement('span', { className: 'state-dot', 'aria-hidden': 'true' }),
        state === 'exited' && mirror?.exitCode != null ? `exited ${mirror.exitCode}` : state,
      ),
    ),
    mirror?.unavailable !== undefined
      ? createElement(
          'p',
          { className: 'session-empty', 'data-testid': 'session-unmirrored' },
          mirror.unavailable,
        )
      : mirror?.screen === undefined
        ? createElement(
            'p',
            { className: 'session-empty' },
            'Waiting for the first frame from this terminal.',
          )
        : createElement(Terminal, {
            screen: mirror.screen,
            live: mirror.running,
            // Only while there is a process to receive them. A dead seat that
            // still swallowed the keyboard would be a trap.
            ...(mirror.running === true ? { onKey: (bytes: string) => void press(bytes, 'that key') } : {}),
          }),
    notice === undefined
      ? null
      : createElement('p', { className: 'session-notice', role: 'alert', 'data-testid': 'session-notice' }, notice),
    // The terminal itself takes the keyboard, so this row is a fallback: touch,
    // where there is no keyboard to focus, and a hint that the panel is
    // driveable at all. Four buttons were briefly the *only* way in, which
    // worked for exactly the four things guessed in advance — the first dialog
    // with a text field would have been unanswerable again.
    //
    // Not gated on `canPush`: a keystroke goes to the pty as bytes, so it works
    // on a seat that reads its prompt once and cannot take another turn.
    mirror?.unavailable !== undefined || mirror?.running !== true
      ? null
      : createElement(
          'div',
          { className: 'session-keys', 'data-testid': 'session-keys' },
          ...KEYS.map(([label, bytes, name]) =>
            createElement(
              'button',
              {
                type: 'button',
                key: name,
                className: 'session-key',
                'data-key': name,
                'aria-label': `Press ${name} in ${seat.id}`,
                onClick: () => void press(bytes, name),
              },
              label,
            ),
          ),
        ),
    // No composer once the process is gone: there is nothing on the other end,
    // and an input that silently does nothing is worse than no input.
    mirror?.unavailable !== undefined || mirror?.running !== true
      ? null
      : createElement(
          'form',
          {
            className: 'session-composer',
            onSubmit: (event: { preventDefault(): void }) => {
              event.preventDefault();
              void send();
            },
          },
          createElement('input', {
            className: 'session-input',
            'data-testid': 'session-input',
            value: draft,
            placeholder: `Type to ${seat.id} — only this seat sees it`,
            'aria-label': `Prompt ${seat.id}`,
            disabled: mirror.canPush === false,
            onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
          }),
          createElement(
            'button',
            {
              type: 'submit',
              className: 'session-send',
              'data-testid': 'session-send',
              disabled: sending || draft.trim() === '' || mirror.canPush === false,
            },
            sending ? 'Sending' : 'Send',
          ),
        ),
  );
}
