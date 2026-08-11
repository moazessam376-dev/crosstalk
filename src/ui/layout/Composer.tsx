import { createElement, useState, type KeyboardEvent } from 'react';
import type { PostResult } from '../state/humanAction.js';

export interface ComposerProps {
  /** The room this message is posted into. Named on screen, not implied. */
  room: string;
  /** Who the daemon will attribute this to. Derived from the cookie, never asserted here. */
  self?: string;
  onSend: (body: string) => Promise<PostResult>;
}

/**
 * The human's way into the conversation.
 *
 * Design §10.3 gives the human a composer on every room, and there was no
 * `<input>` or `<textarea>` anywhere in `src/ui/` — the person the ladder ends
 * on could read the argument and not answer it.
 *
 * The field clears only on a confirmed post. Losing what someone typed because
 * a request failed is not an acceptable failure mode, and it is the one thing
 * a composer must never do.
 */
export function Composer({ room, self = '@human', onSend }: ComposerProps) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  async function send(): Promise<void> {
    const text = body.trim();
    // Whitespace is not a message. Posting it would put an empty card in
    // everyone's stream.
    if (text.length === 0) return;

    setSending(true);
    const result = await onSend(text);
    setSending(false);

    if (result.ok) {
      setBody('');
      setError(undefined);
      return;
    }
    setError(result.reason);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Shift+Enter is how you write a second line. Sending it would eat a
    // half-written message.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  return createElement(
    'form',
    {
      className: 'composer',
      'data-testid': 'composer',
      onSubmit: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        void send();
      },
    },
    createElement(
      'div',
      { className: 'composer-meta' },
      createElement('span', null, 'posting as'),
      createElement('span', { className: 'composer-identity', 'data-testid': 'composer-identity' }, self),
      createElement('span', null, 'into'),
      createElement('span', { className: 'composer-room fact' }, room),
      // Said out loud because it is true and easy to forget: this is not a
      // private note to the leader.
      createElement('span', { className: 'composer-scope' }, 'everyone in this room sees it'),
    ),
    createElement('textarea', {
      className: 'composer-input',
      'data-testid': 'composer-input',
      'aria-label': `post to ${room} as ${self}`,
      placeholder: `Message ${room} — @mention an agent to route it`,
      rows: 2,
      value: body,
      disabled: sending,
      onKeyDown,
      onChange: (event: { target: { value: string } }) => setBody(event.target.value),
    }),
    createElement(
      'div',
      { className: 'composer-actions' },
      createElement('span', { className: 'composer-route fact' }, 'POST /events'),
      createElement(
        'button',
        {
          type: 'submit',
          className: 'composer-send',
          'data-testid': 'composer-send',
          'aria-label': sending ? 'Sending' : 'Send',
          title: sending ? 'Sending' : 'Send',
          disabled: sending || body.trim().length === 0,
        },
        createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': 'true' },
          createElement('path', { d: 'M8 13V3.5' }),
          createElement('path', { d: 'M3.8 7.5 8 3.3l4.2 4.2' }),
        ),
      ),
    ),
    error === undefined
      ? null
      : createElement('p', { className: 'composer-error', role: 'alert', 'data-testid': 'composer-error' }, error),
  );
}
